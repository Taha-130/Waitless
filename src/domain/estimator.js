/**
 * ---------------------------------------------------------------------------
 * ESTIMATION DE L'ATTENTE
 * ---------------------------------------------------------------------------
 * Ce que le visiteur veut savoir : « dans combien de temps vais-je entrer dans
 * la Salle du Temps ? ». Son attente traverse les deux etages :
 *
 *   attente totale = attente dans la file VIRTUELLE
 *                  + traversee de la file REELLE
 *
 * Le calcul repose sur un seul chiffre, le DEBIT, c'est-a-dire le nombre de
 * personnes qui entrent dans la salle par heure. Il n'est plus decrete par un
 * nombre de places par cycle : la salle fonctionne en flux continu, donc
 *
 *   debit nominal = capacite de la salle / duree moyenne de sejour
 *                 = 50 personnes / 75 s = 2 400 personnes par heure
 *
 * (sejour de 30 s a 2 min, 75 s en moyenne). A ce rythme, ce n'est plus la
 * salle qui limite le debit en pratique, mais le controle a l'entree et le
 * temps que mettent les convoques a rejoindre la file reelle : d'ou
 * l'importance du recalage sur les entrees observees.
 *
 * Cette valeur n'est qu'une hypothese de depart, puisque chacun sort quand il
 * veut : elle est recalee sur les entrees REELLEMENT observees des qu'il y en a
 * assez pour que la mesure ait un sens.
 *
 * Deux raffinements conserves du modele precedent :
 *  - l'attente integre les passages prioritaires attendus PENDANT cette
 *    attente : plus j'attends, plus des Saiyans me depassent, donc plus
 *    j'attends. D'ou un calcul iteratif (point fixe) qui converge en quelques
 *    passes ;
 *  - on affiche une fourchette, elargie apres un incident.
 * ---------------------------------------------------------------------------
 */

import { maintenant } from './clock.js';
import { dureeSejourMoyenneSec } from '../config/rules.js';
import { ticketsEnAttente, ticketsConvoques, ticketsValides, msEnPause } from './state.js';
import { dernierReleve } from '../infra/sensor.js';

/**
 * Debit nominal, en visiteurs par heure, deduit de la physique de la salle.
 * 50 places liberees en moyenne toutes les 75 secondes = 2 400 entrees par heure.
 */
export function debitNominal(regles) {
  return regles.capaciteSalle * (3600 / dureeSejourMoyenneSec(regles));
}

/**
 * Debit effectif : moitie nominal, moitie observe sur les 30 dernieres minutes,
 * penalise quand la salle est pleine — une salle pleine n'accepte personne tant
 * que quelqu'un n'en sort pas.
 */
export function debitEffectif(state, occupationSalle = 0) {
  const r = state.regles;
  const nominal = debitNominal(r);
  const now = maintenant();
  const fenetreMin = 30;

  // L'entree dans la salle n'est pas scannee : on observe le rythme des scans a
  // l'entree de la file reelle, qui est le meme en regime etabli.
  const entrees = Object.values(state.tickets).filter(
    (t) => t.valideA !== null && now - t.valideA <= fenetreMin * 60_000,
  ).length;

  // On ne fait confiance a l'observation qu'a partir de 5 passages.
  const observe = entrees >= 5 ? entrees * (60 / fenetreMin) : null;
  let debit = observe === null ? nominal : 0.5 * nominal + 0.5 * observe;

  // Salle proche de la saturation : plus personne n'entre sans une sortie.
  const taux = occupationSalle / r.capaciteSalle;
  if (taux >= 1) debit *= 0.6;
  else if (taux >= 0.9) debit *= 0.85;

  return Math.max(1, debit);
}

/**
 * Nombre de visiteurs de la file VIRTUELLE qui passeront avant un ticket donne.
 * Pour un ticket hypothetique (nouvelle inscription), passer rang = Infinity.
 */
export function nombreDevantVirtuel(state, statut, rang = Infinity) {
  const rangPrio = state.regles.statuts[statut]?.rang ?? 99;
  return ticketsEnAttente(state).filter((t) => {
    const rp = state.regles.statuts[t.statut]?.rang ?? 99;
    return rp < rangPrio || (rp === rangPrio && t.rang < rang);
  }).length;
}

/* ------------------------------------------------------------------------ */
/* File reelle : une estimation, faute de detection                          */
/* ------------------------------------------------------------------------ */

/**
 * Visiteurs scannes presumes encore dans la file reelle.
 *
 * Le seul scan a lieu a l'entree de la file reelle ; l'entree dans la salle se
 * fait sans verification. Le systeme ne sait donc pas qui attend encore et qui
 * est deja dans la salle. On suppose que la file s'ecoule dans l'ordre du scan,
 * au debit effectif : chacun entre un intervalle apres le precedent, et jamais
 * avant d'avoir ete scanne. Les pauses ne font pas avancer la file (RG-12).
 */
export function ticketsFileReelle(state, now = maintenant()) {
  const valides = ticketsValides(state);
  if (!valides.length) return [];
  const intervalleMs = 3_600_000 / debitEffectif(state, dernierReleve().occupation);
  const actif = (ts) => ts - msEnPause(state, 0, ts);
  const maintenantActif = actif(now);

  const presents = [];
  let entree = -Infinity;
  for (const t of valides) {
    entree = Math.max(actif(t.valideA), entree) + intervalleMs;
    if (entree > maintenantActif) presents.push(t);
  }
  return presents;
}

/**
 * Places occupees ou reservees dans la file reelle : les scannes presumes encore
 * sur place, plus les convoques en route, dont la place est deja reservee.
 */
export function occupationFileReelle(state, now = maintenant()) {
  return ticketsFileReelle(state, now).length + ticketsConvoques(state).length;
}

/** Places encore libres dans la file reelle (RG-16). */
export function placesFileReelle(state, now = maintenant()) {
  return Math.max(0, state.regles.capaciteFileReelle - occupationFileReelle(state, now));
}

/**
 * Nombre de visiteurs deja engages dans la file REELLE : ceux qui y patientent,
 * et ceux qui sont en route avec une place reservee. Tous entreront avant le
 * nouvel inscrit, quel que soit son statut : ils ont deja quitte le parc.
 */
export function nombreDevantReel(state) {
  return occupationFileReelle(state);
}

/** Arrivees par heure des statuts strictement plus prioritaires que `statut`. */
function tauxArriveePrioritaire(state, statut) {
  const r = state.regles;
  const rangPrio = r.statuts[statut]?.rang ?? 99;
  const now = maintenant();
  const fenetreMin = 60;

  const arrivees = Object.values(state.tickets).filter(
    (t) => now - t.creeA <= fenetreMin * 60_000 && (r.statuts[t.statut]?.rang ?? 99) < rangPrio,
  ).length;

  if (arrivees > 0) return arrivees * (60 / fenetreMin);

  // Pas encore d'historique : on retombe sur les hypotheses du cahier
  // (80 % Humains, 15 % Saiyans, 5 % Super Saiyans) appliquees au debit.
  const parts = { SUPER_SAIYAN: 0.05, SAIYAN: 0.15, HUMAIN: 0.8 };
  let part = 0;
  for (const [code, cfg] of Object.entries(r.statuts)) {
    if (cfg.rang < rangPrio) part += parts[code] ?? 0;
  }
  return part * debitNominal(r);
}

/**
 * Estimation en minutes pour un statut donne.
 *
 * @param {object} state
 * @param {string} statut
 * @param {{rang?:number, occupationSalle?:number, devantReel?:number}} options
 * @returns {{minutes:number, minutesVirtuelle:number, minutesFileReelle:number,
 *            basse:number, haute:number, devant:number, devantVirtuel:number,
 *            devantReel:number, debit:number, elargie:boolean}}
 */
export function estimer(state, statut, { rang = Infinity, occupationSalle = 0, devantReel } = {}) {
  const r = state.regles;
  const debit = debitEffectif(state, occupationSalle);
  const devantVirtuel = nombreDevantVirtuel(state, statut, rang);
  const reel = devantReel ?? nombreDevantReel(state);
  const devant = devantVirtuel + reel;
  const tauxPrio = tauxArriveePrioritaire(state, statut);

  // --- Point fixe : attente = (devant + prioritaires arrives entre-temps) / debit
  let attente = (devant / debit) * 60;
  for (let passe = 0; passe < 6; passe++) {
    const prioritairesAttendus = tauxPrio * (attente / 60);
    const suivante = ((devant + prioritairesAttendus) / debit) * 60;
    // Divergence possible si les prioritaires arrivent plus vite que le debit :
    // on borne pour ne jamais annoncer un chiffre absurde.
    if (!Number.isFinite(suivante) || suivante > r.attenteMaxAffichableMin) {
      attente = r.attenteMaxAffichableMin;
      break;
    }
    if (Math.abs(suivante - attente) < 0.5) { attente = suivante; break; }
    attente = suivante;
  }

  // Part de l'attente qui se deroulera debout, devant l'attraction. Les
  // prioritaires qui arriveront plus tard ne doublent pas la file reelle :
  // cette portion-la se calcule donc sans le point fixe.
  const minutesFileReelle = Math.min(attente, (reel / debit) * 60);

  // Un incident recent (moins de 30 min) elargit la fourchette.
  const incidentRecent = state.incidents.some(
    (i) => i.fin === null || maintenant() - i.fin < 30 * 60_000,
  );
  const elargissement = incidentRecent ? r.elargissementIncident : 1;

  // La somme des deux parts doit faire le total affiche, a la minute pres :
  // un visiteur qui lit « 8 min dans le parc puis 12 min sur place » et un
  // total de 21 min se demanderait, a juste titre, ou est passee la minute.
  const minutes = Math.round(attente);
  const partReelle = Math.min(minutes, Math.round(minutesFileReelle));
  return {
    minutes,
    minutesVirtuelle: minutes - partReelle,
    minutesFileReelle: partReelle,
    basse: Math.max(0, Math.floor(minutes * r.facteurFourchetteBasse)),
    haute: Math.ceil(minutes * r.facteurFourchetteHaute * elargissement),
    devant,
    devantVirtuel,
    devantReel: reel,
    debit: Math.round(debit),
    elargie: incidentRecent,
  };
}

/** Estimation pour chacun des trois statuts (ecran d'accueil, tableau de bord). */
export function estimerTousStatuts(state, occupationSalle = 0) {
  const sortie = {};
  const devantReel = nombreDevantReel(state);
  for (const code of Object.keys(state.regles.statuts)) {
    sortie[code] = estimer(state, code, { occupationSalle, devantReel });
  }
  return sortie;
}

/** Nombre total de personnes devant, les deux etages confondus. */
export function nombreDevant(state, statut, rang = Infinity) {
  return nombreDevantVirtuel(state, statut, rang) + nombreDevantReel(state);
}