/**
 * ---------------------------------------------------------------------------
 * ORDONNANCEUR
 * ---------------------------------------------------------------------------
 * Le coeur du projet. A chaque battement (5 s par defaut) il enchaine :
 *
 *   1. expirer les convocations depassees              (RG-10)
 *   2. envoyer les rappels 2 min avant la fin          (parcours « retard »)
 *   3. avertir les visiteurs menaces par 19h00         (RG-05 / F-07)
 *   4. convoquer, si des places sont libres            (RG-06/07/08)
 *
 * La selection combine, comme demande au chapitre 5 : « l'echeance des
 * garanties, les quotas par statut et l'ordre d'arrivee ».
 * ---------------------------------------------------------------------------
 */

import { maintenant, minutesDuJour, formatHeure } from './clock.js';
import { etat, publier, verifierJour } from './eventStore.js';
import {
  ETATS_TICKET, ticketsEnAttente, ticketsConvoques, tempsActifEcoule,
} from './state.js';
import { estimer } from './estimator.js';
import { envoyer } from '../infra/mailer.js';
import { releverCapteur, dernierReleve } from '../infra/sensor.js';

/* ------------------------------------------------------------------------ */
/* Cycles d'exploitation                                                     */
/* ------------------------------------------------------------------------ */

/** Index du cycle en cours (0 = premier cycle de la journee). */
export function cycleCourant(state = etat()) {
  const r = state.regles;
  const ecoule = minutesDuJour() - r.debutExploitation;
  return Math.max(0, Math.floor(ecoule / r.dureeCycleMin));
}

/** Minutes restantes avant le prochain cycle. */
export function minutesAvantProchainCycle(state = etat()) {
  const r = state.regles;
  const ecoule = minutesDuJour() - r.debutExploitation;
  if (ecoule < 0) return r.debutExploitation - minutesDuJour();
  return r.dureeCycleMin - (ecoule % r.dureeCycleMin);
}

/** Places deja consommees (entrees + convocations en cours) sur un cycle. */
export function comptageCycle(state, cycle) {
  const parStatut = {};
  let total = 0;
  for (const t of Object.values(state.tickets)) {
    if (t.cycle !== cycle) continue;
    if (![ETATS_TICKET.CONVOQUE, ETATS_TICKET.ENTRE].includes(t.etat)) continue;
    parStatut[t.statut] = (parStatut[t.statut] || 0) + 1;
    total++;
  }
  return { parStatut, total };
}

/* ------------------------------------------------------------------------ */
/* Garanties de delai                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Minutes restantes avant que la garantie du statut ne soit rompue.
 * null si le statut n'a pas de garantie. Le temps de pause est deduit (RG-12).
 */
export function resteGarantieMin(state, ticket, now = maintenant()) {
  const garantie = state.regles.statuts[ticket.statut]?.garantieMin;
  if (garantie === null || garantie === undefined) return null;
  const ecouleMin = tempsActifEcoule(state, ticket.creeA, now) / 60_000;
  return garantie - ecouleMin;
}

/* ------------------------------------------------------------------------ */
/* Battement principal                                                       */
/* ------------------------------------------------------------------------ */

export async function battement() {
  verifierJour();
  const state = etat();

  // Releve du capteur : borne haute des convocations (F-14).
  const convoques = ticketsConvoques(state).length;
  await releverCapteur(state.regles.capteurUrl, convoques);

  expirerConvocations(state);
  envoyerRappels(state);
  avertirFinDeJournee(state);
  ordonnancer(state);
}

/* --- 1. Expiration (RG-10) ---------------------------------------------- */

function expirerConvocations(state) {
  const now = maintenant();
  const limite = (state.regles.delaiConvocationSec + state.regles.delaiGraceSec) * 1000;

  for (const t of ticketsConvoques(state)) {
    if (tempsActifEcoule(state, t.convoqueA, now) > limite) {
      publier('TICKET_EXPIRE', { ticketId: t.id, motif: 'Absence à la convocation' });
      const v = state.visiteurs[t.visiteurId];
      if (v) {
        envoyer(v.email, 'Votre convocation a expiré',
          "Vous ne vous êtes pas présenté à temps. Votre place a été réattribuée. Vous pouvez vous réinscrire en fin de file depuis l'application.",
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
          `Il vous reste environ ${Math.round(state.regles.rappelAvantFinSec / 60)} minutes pour vous présenter à la Salle du Temps.`,
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

  // On part des derniers inscrits : si l'un d'eux passe a temps, tous ceux qui
  // le precedent passent aussi. On s'arrete donc au premier non menace.
  for (let i = enAttente.length - 1; i >= 0; i--) {
    const t = enAttente[i];
    const est = estimer(state, t.statut, { rang: t.rang, occupationSalle: occupation });
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

/* --- 4. Convocation (RG-06, RG-07, RG-08, F-14) ------------------------- */

/**
 * Selectionne et convoque les visiteurs.
 * Exporte pour etre appelee aussi juste apres une inscription : c'est ce qui
 * rend le passage Super Saiyan « immediat, sans file » (RG-06).
 */
export function ordonnancer(state = etat()) {
  const r = state.regles;
  const minutes = minutesDuJour();

  // F-03 / RG-01 : aucune convocation hors de la plage d'exploitation.
  if (state.file.etat !== 'OUVERTE') return [];
  if (minutes < r.debutExploitation || minutes >= r.finExploitation) return [];

  const cycle = cycleCourant(state);
  const { parStatut: servis, total: servisTotal } = comptageCycle(state, cycle);
  const occupation = dernierReleve().occupation;
  const enCours = ticketsConvoques(state).length;

  // Deux plafonds : les places du cycle, et la capacite physique de la salle.
  const placesCycle = r.placesParCycle - servisTotal;
  const placesSalle = r.capaciteSalleAttente - Math.max(occupation, enCours);
  let restant = Math.max(0, Math.min(placesCycle, placesSalle));
  if (restant === 0) return [];

  // Quotas maximaux par statut sur ce cycle (RG-06 : 15 % pour les Super Saiyans).
  const quotas = {};
  for (const [code, cfg] of Object.entries(r.statuts)) {
    quotas[code] = Math.max(0, Math.ceil(cfg.quotaCycle * r.placesParCycle) - (servis[code] || 0));
  }

  // RG-08 : part minimale reservee aux Humains, pour eviter la famine.
  const attente = ticketsEnAttente(state);
  const dusHumains = Math.max(0, Math.floor(r.statuts.HUMAIN.partMin * r.placesParCycle) - (servis.HUMAIN || 0));
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
    if ((quotas[t.statut] ?? 0) <= 0) continue;
    // On garde les dernieres places pour les Humains qui leur sont dues.
    if (t.statut !== 'HUMAIN' && restant <= reserveHumain) continue;

    publier('TICKET_CONVOQUE', { ticketId: t.id, cycle });
    convoques.push(t.id);
    quotas[t.statut]--;
    restant--;
    if (t.statut === 'HUMAIN' && reserveHumain > 0) reserveHumain--;

    const v = state.visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'C\'est votre tour — présentez-vous à la Salle du Temps',
        `Vous avez ${Math.round(r.delaiConvocationSec / 60)} minutes pour vous présenter. Ouvrez l'application et montrez votre code à l'agent.`,
        'CONVOCATION');
    }
  }
  return convoques;
}

/**
 * Cle d'urgence : 0 si la garantie du ticket risque d'etre rompue avant le
 * prochain cycle, 1 sinon. Les Super Saiyans (garantie 0 min) sont toujours
 * urgents, ce qui realise l'acces prioritaire absolu de RG-06.
 */
function urgence(state, ticket) {
  const reste = resteGarantieMin(state, ticket);
  if (reste === null) return 1;
  return reste <= state.regles.dureeCycleMin ? 0 : 1;
}
