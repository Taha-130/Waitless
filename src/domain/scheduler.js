/**
 * ---------------------------------------------------------------------------
 * ORDONNANCEUR
 * ---------------------------------------------------------------------------
 * Le coeur du projet. A chaque battement (5 s par defaut) il enchaine :
 *
 *   1. expirer les convocations depassees              (RG-10)
 *   2. envoyer les rappels 2 min avant la fin          (parcours « retard »)
 *   3. avertir les visiteurs menaces par 19h00         (RG-05 / F-07)
 *   4. convoquer vers la FILE REELLE, si elle a de la place (RG-06/07/08/16)
 *
 * ---------------------------------------------------------------------------
 * CE QUE L'ORDONNANCEUR DECIDE, ET CE QU'IL NE DECIDE PAS
 * ---------------------------------------------------------------------------
 * Il decide QUI quitte le parc pour aller faire la queue devant l'attraction,
 * et il ne convoque que tant que les 30 places de la file reelle ne sont pas
 * toutes prises ou reservees.
 *
 * Il ne decide PAS qui entre dans la Salle du Temps : c'est l'agent de la
 * porte, sans application, qui fait entrer les visiteurs de la file reelle au
 * rythme des places qui se liberent. La salle n'a pas de fournee, pas de
 * cycle, pas d'horaire : les gens en sortent quand ils veulent.
 *
 * L'entree dans la salle n'etant pas scannee, l'occupation de la file reelle
 * est une ESTIMATION (voir estimator.js : ticketsFileReelle) : les convoques en
 * route, plus les scannes presumes encore dans la file au debit effectif.
 * ---------------------------------------------------------------------------
 */

import { maintenant, minutesDuJour, formatHeure } from './clock.js';
import { etat, publier, verifierJour } from './eventStore.js';
import {
  ticketsEnAttente, ticketsConvoques, occupationSalleEstimee, tempsActifEcoule,
} from './state.js';
import {
  estimer, nombreDevantReel, ticketsFileReelle, occupationFileReelle, placesFileReelle,
} from './estimator.js';
import { envoyer } from '../infra/mailer.js';
import { releverCapteur, dernierReleve } from '../infra/sensor.js';

/* ------------------------------------------------------------------------ */
/* Quotas sur fenetre glissante                                              */
/* ------------------------------------------------------------------------ */

/**
 * Les `taille` dernieres convocations, de la plus recente a la plus ancienne.
 * Toutes les convocations comptent, y compris celles qui ont fini en absence :
 * une place offerte reste une place offerte, meme si elle a ete gachee.
 */
export function historiqueConvocations(state, taille = state.regles.fenetreQuotaConvocations) {
  return Object.values(state.tickets)
    .filter((t) => t.convoqueA !== null)
    .sort((a, b) => b.convoqueA - a.convoqueA)
    .slice(0, taille);
}

/**
 * Compte, par statut, les convocations de la fenetre glissante.
 * Remplace le « comptage par cycle » : meme role, mais continu.
 */
export function comptageFenetre(state) {
  const parStatut = {};
  let total = 0;
  for (const t of historiqueConvocations(state)) {
    parStatut[t.statut] = (parStatut[t.statut] || 0) + 1;
    total++;
  }
  return { parStatut, total };
}

/**
 * Plafond d'un statut, en nombre de convocations, sur la fenetre.
 *
 * Le denominateur est la taille REELLE de la fenetre, pas sa taille maximale :
 * au dixieme visiteur de la journee, « 15 % » doit vouloir dire 15 % de dix,
 * pas 15 % de cinquante. Sans cela, les premieres convocations de la journee
 * echapperaient entierement au quota.
 */
function plafond(state, code, totalFenetre) {
  const r = state.regles;
  const part = r.statuts[code]?.quotaFenetre ?? 1;
  const taille = Math.min(r.fenetreQuotaConvocations, totalFenetre + 1);
  return Math.ceil(part * taille);
}

/* ------------------------------------------------------------------------ */
/* Garanties de delai                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Minutes restantes avant que la garantie du statut ne soit rompue.
 * null si le statut n'a pas de garantie. Le temps de pause est deduit (RG-12).
 *
 * La garantie court de l'inscription jusqu'a la CONVOCATION, et non jusqu'a
 * l'entree dans la salle : c'est la seule partie de l'attente que le systeme
 * maitrise. Au-dela, le visiteur depend de sa propre vitesse pour rejoindre la
 * file reelle, et du moment ou les occupants decident de sortir.
 */
export function resteGarantieMin(state, ticket, now = maintenant()) {
  const garantie = state.regles.statuts[ticket.statut]?.garantieMin;
  if (garantie === null || garantie === undefined) return null;
  const fin = ticket.convoqueA ?? now;      // une fois convoque, la garantie est figee
  const ecouleMin = tempsActifEcoule(state, ticket.creeA, fin) / 60_000;
  return garantie - ecouleMin;
}

/* ------------------------------------------------------------------------ */
/* Battement principal                                                       */
/* ------------------------------------------------------------------------ */

export async function battement() {
  verifierJour();
  const state = etat();

  // Releve du capteur de la Salle du Temps. A defaut de capteur, on retombe sur
  // une estimation interne (entrees + duree moyenne de sejour) pour que
  // l'exploitation — et la demonstration — ne s'arretent jamais.
  await releverCapteur(state.regles.capteurUrl, occupationSalleEstimee(state, maintenant()));

  expirerConvocations(state);
  envoyerRappels(state);
  avertirFinDeJournee(state);
  ordonnancer(state);
}

/* --- 1. Expiration (RG-10) ---------------------------------------------- */

/**
 * N'expirent que les CONVOQUES : ceux qui ont ete appeles et ne se sont pas
 * presentes. Un visiteur scanne a l'entree de la file reelle ne peut plus
 * expirer : son code est valide, il est la.
 */
function expirerConvocations(state) {
  const now = maintenant();
  const limite = (state.regles.delaiConvocationSec + state.regles.delaiGraceSec) * 1000;

  for (const t of ticketsConvoques(state)) {
    if (tempsActifEcoule(state, t.convoqueA, now) > limite) {
      publier('TICKET_EXPIRE', { ticketId: t.id, motif: 'Absence à la convocation' });
      const v = state.visiteurs[t.visiteurId];
      if (v) {
        envoyer(v.email, 'Votre convocation a expiré',
          "Vous ne vous êtes pas présenté à l'entrée de la Salle du Temps à temps. Votre place a été réattribuée. Vous pouvez vous réinscrire en fin de file depuis l'application.",
          'EXPIRATION');
      }
    }
  }
}

/* --- 2. Rappel avant expiration ----------------------------------------- */

function envoyerRappels(state) {
  const now = maintenant();
  const seuil = (state.regles.delaiConvocationSec - state.regles.rappelAvantFinSec) * 1000;

  for (const t of ticketsConvoques(state)) {
    if (t.rappeleA) continue;
    if (tempsActifEcoule(state, t.convoqueA, now) >= seuil) {
      publier('RAPPEL_ENVOYE', { ticketId: t.id });
      const v = state.visiteurs[t.visiteurId];
      if (v) {
        envoyer(v.email, 'Dernière minute pour vous présenter',
          `Il vous reste environ ${Math.round(state.regles.rappelAvantFinSec / 60)} minutes pour rejoindre la file d'attente de la Salle du Temps.`,
          'RAPPEL');
      }
    }
  }
}

/* --- 3. Vigilance de fin de journee (RG-05 / F-07) ---------------------- */

function avertirFinDeJournee(state) {
  const r = state.regles;
  const minutes = minutesDuJour();
  if (minutes < r.debutExploitation) return;

  const occupation = dernierReleve().occupation;
  const enAttente = ticketsEnAttente(state);
  const devantReel = nombreDevantReel(state);

  // On part des derniers inscrits : si l'un d'eux passe a temps, tous ceux qui
  // le precedent passent aussi. On s'arrete donc au premier non menace.
  for (let i = enAttente.length - 1; i >= 0; i--) {
    const t = enAttente[i];
    const est = estimer(state, t.statut, {
      rang: t.rang, occupationSalle: occupation, devantReel,
    });
    const menace = minutes + est.minutes > r.finExploitation - r.seuilVigilanceMin;
    if (!menace) break;
    if (t.avertiFinJournee) continue;

    publier('VIGILANCE_ENVOYEE', { ticketId: t.id });
    const v = state.visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'Votre passage avant la fermeture n\'est pas assuré',
        `L'attente estimée dépasse l'heure de fermeture (${formatHeure(maintenant())} + ${est.minutes} min). Vous pouvez rester dans la file ou vous désister sans pénalité.`,
        'VIGILANCE');
    }
  }
}

/* --- 4. Convocation vers la file reelle (RG-06, RG-07, RG-08, RG-16) ---- */

/**
 * Selectionne et convoque les visiteurs de la file virtuelle vers la file
 * reelle. Exporte pour etre appelee aussi juste apres une inscription : c'est
 * ce qui rend le passage Super Saiyan « immediat, sans file » (RG-06).
 */
export function ordonnancer(state = etat()) {
  const r = state.regles;
  const minutes = minutesDuJour();

  // F-03 / RG-01 : aucune convocation hors de la plage d'exploitation.
  if (state.file.etat !== 'OUVERTE') return [];
  if (minutes < r.debutExploitation || minutes >= r.finExploitation) return [];

  // RG-16 : seul plafond de la convocation, la file reelle. On compte les
  // scannes presumes encore sur place ET les convoques en route, sans quoi une
  // rafale de convocations enverrait 30 personnes de plus sur une file pleine.
  let restant = placesFileReelle(state);
  if (restant === 0) return [];

  const { parStatut: comptes, total: totalFenetre } = comptageFenetre(state);
  const compteur = { ...comptes };
  let total = totalFenetre;

  // RG-08 : part minimale reservee aux Humains, pour eviter la famine.
  // La fenetre de reference inclut les convocations que l'on s'apprete a faire.
  // Sinon, au tout premier appel de la journee, la fenetre vaut 1, la part due
  // vaut 0, et la reserve ne protegerait personne au moment ou trente places
  // partent d'un coup.
  const attente = ticketsEnAttente(state);
  const tailleProjetee = Math.min(r.fenetreQuotaConvocations, Math.max(1, total + restant));
  const dusHumains = Math.max(
    0,
    Math.floor((r.statuts.HUMAIN?.partMin ?? 0) * tailleProjetee) - (compteur.HUMAIN || 0),
  );
  let reserveHumain = Math.min(dusHumains, attente.filter((t) => t.statut === 'HUMAIN').length);

  // Ordre de selection : urgence de garantie, puis priorite, puis arrivee.
  const candidats = [...attente].sort((a, b) => {
    const ua = urgence(state, a), ub = urgence(state, b);
    if (ua !== ub) return ua - ub;
    const ra = r.statuts[a.statut]?.rang ?? 99;
    const rb = r.statuts[b.statut]?.rang ?? 99;
    return ra - rb || a.rang - b.rang;
  });

  const convoques = [];
  for (const t of candidats) {
    if (restant === 0) break;
    // RG-06 : quota du statut sur la fenetre glissante des convocations.
    if ((compteur[t.statut] || 0) + 1 > plafond(state, t.statut, total)) continue;
    // On garde les dernieres places pour les Humains qui leur sont dues.
    if (t.statut !== 'HUMAIN' && restant <= reserveHumain) continue;

    publier('TICKET_CONVOQUE', { ticketId: t.id });
    convoques.push(t.id);
    compteur[t.statut] = (compteur[t.statut] || 0) + 1;
    total++;
    restant--;
    if (t.statut === 'HUMAIN' && reserveHumain > 0) reserveHumain--;

    const v = state.visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'C\'est votre tour — rejoignez la Salle du Temps',
        `Vous avez ${Math.round(r.delaiConvocationSec / 60)} minutes pour rejoindre la file d'attente située devant l'attraction. Un agent y scannera votre code à votre arrivée.`,
        'CONVOCATION');
    }
  }
  return convoques;
}

/**
 * Cle d'urgence : 0 si la garantie du ticket est sur le point d'etre rompue,
 * 1 sinon. Les Super Saiyans (garantie 0 min) sont toujours urgents, ce qui
 * realise l'acces prioritaire absolu de RG-06.
 */
function urgence(state, ticket) {
  const reste = resteGarantieMin(state, ticket);
  if (reste === null) return 1;
  return reste <= state.regles.horizonUrgenceMin ? 0 : 1;
}

/* ------------------------------------------------------------------------ */
/* Lectures utilisees par les vues                                           */
/* ------------------------------------------------------------------------ */

/** Etat des deux etages d'attente, pour les trois interfaces. */
export function etatDesFiles(state = etat()) {
  const capteur = dernierReleve();
  return {
    fileVirtuelle: ticketsEnAttente(state).length,
    convoques: ticketsConvoques(state).length,
    fileReelle: ticketsFileReelle(state).length,
    occupationFileReelle: occupationFileReelle(state),
    placesFileReelle: placesFileReelle(state),
    capaciteFileReelle: state.regles.capaciteFileReelle,
    occupationSalle: capteur.occupation,
    capaciteSalle: state.regles.capaciteSalle,
    placesSalle: Math.max(0, state.regles.capaciteSalle - capteur.occupation),
    sourceCapteur: capteur.source,
  };
}
