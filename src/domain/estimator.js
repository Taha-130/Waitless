/**
 * ---------------------------------------------------------------------------
 * ESTIMATION DE L'ATTENTE
 * ---------------------------------------------------------------------------
 * Reprend le « principe d'estimation » du chapitre 5 :
 *
 *  1. Le debit nominal est corrige par le debit reellement observe et par
 *     l'occupation de la salle d'attente.
 *  2. L'attente d'un nouveau ticket integre les passages prioritaires attendus
 *     PENDANT cette attente : plus j'attends, plus des Saiyans me depassent,
 *     donc plus j'attends. D'ou un calcul itératif (point fixe) qui converge en
 *     quelques passes.
 *  3. On affiche une fourchette, elargie apres un incident.
 * ---------------------------------------------------------------------------
 */

import { maintenant } from './clock.js';
import { ticketsEnAttente, ticketsConvoques, ETATS_TICKET } from './state.js';

/** Debit nominal, en visiteurs par heure (ex. 20 places / 20 min = 60/h). */
export function debitNominal(regles) {
  return regles.placesParCycle * (60 / regles.dureeCycleMin);
}

/**
 * Debit effectif : moitie nominal, moitie observe sur les 30 dernieres minutes,
 * penalise si la salle d'attente est saturee.
 */
export function debitEffectif(state, occupationSalle = 0) {
  const r = state.regles;
  const nominal = debitNominal(r);
  const now = maintenant();
  const fenetreMin = 30;

  const entrees = Object.values(state.tickets).filter(
    (t) => t.etat === ETATS_TICKET.ENTRE && now - t.entreA <= fenetreMin * 60_000,
  ).length;

  // On ne fait confiance a l'observation qu'a partir de 5 passages.
  const observe = entrees >= 5 ? entrees * (60 / fenetreMin) : null;
  let debit = observe === null ? nominal : 0.5 * nominal + 0.5 * observe;

  // Salle d'attente proche de la saturation : le debit reel se degrade.
  const taux = occupationSalle / r.capaciteSalleAttente;
  if (taux >= 0.9) debit *= 0.85;

  return Math.max(1, debit);
}

/**
 * Nombre de visiteurs qui passeront avant un ticket donne.
 * Pour un ticket hypothetique (nouvelle inscription), passer rang = Infinity.
 */
export function nombreDevant(state, statut, rang = Infinity) {
  const rangPrio = state.regles.statuts[statut]?.rang ?? 99;
  const devantEnAttente = ticketsEnAttente(state).filter((t) => {
    const rp = state.regles.statuts[t.statut]?.rang ?? 99;
    return rp < rangPrio || (rp === rangPrio && t.rang < rang);
  }).length;

  // Les visiteurs deja convoques occupent des places : ils comptent aussi.
  return devantEnAttente + ticketsConvoques(state).length;
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
 * @returns {{minutes:number, basse:number, haute:number, devant:number, debit:number}}
 */
export function estimer(state, statut, { rang = Infinity, occupationSalle = 0 } = {}) {
  const r = state.regles;
  const debit = debitEffectif(state, occupationSalle);
  const devant = nombreDevant(state, statut, rang);
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

  // Un incident recent (moins de 30 min) elargit la fourchette.
  const incidentRecent = state.incidents.some(
    (i) => i.fin === null || maintenant() - i.fin < 30 * 60_000,
  );
  const elargissement = incidentRecent ? r.elargissementIncident : 1;

  const minutes = Math.round(attente);
  return {
    minutes,
    basse: Math.max(0, Math.floor(minutes * r.facteurFourchetteBasse)),
    haute: Math.ceil(minutes * r.facteurFourchetteHaute * elargissement),
    devant,
    debit: Math.round(debit),
    elargie: incidentRecent,
  };
}

/** Estimation pour chacun des trois statuts (ecran d'accueil, tableau de bord). */
export function estimerTousStatuts(state, occupationSalle = 0) {
  const sortie = {};
  for (const code of Object.keys(state.regles.statuts)) {
    sortie[code] = estimer(state, code, { occupationSalle });
  }
  return sortie;
}
