/**
 * ---------------------------------------------------------------------------
 * COMMANDES METIER
 * ---------------------------------------------------------------------------
 * Un point d'entree par action possible sur la file. Chaque commande :
 *   1. verifie les regles (RG-xx citees en commentaire) ;
 *   2. refuse par une ErreurMetier explicite si une regle n'est pas satisfaite ;
 *   3. publie un ou plusieurs evenements dans le journal.
 *
 * Garde-fou fondateur du cahier des charges : il n'existe AUCUNE commande
 * permettant a un operateur d'ajouter un visiteur dans la file. Seule
 * `rejoindreFile()` cree un ticket, et elle exige l'identite du visiteur.
 * ---------------------------------------------------------------------------
 */

import { maintenant, minutesDuJour, timestampDuJour } from './clock.js';
import { etat, publier, nouvelId } from './eventStore.js';
import {
  ETATS_TICKET, ticketActifDe, ticketsEnAttente, ticketsConvoques,
  tempsActifEcoule, comparerOrdrePassage,
} from './state.js';
import { estimer } from './estimator.js';
import { verifierJeton } from './qr.js';
import { chercherBillet } from '../infra/billetterie.js';
import { envoyer } from '../infra/mailer.js';
import { dernierReleve } from '../infra/sensor.js';

/** Erreur de regle metier : remontee telle quelle a l'utilisateur. */
export class ErreurMetier extends Error {
  constructor(message, code = 'REGLE_NON_SATISFAITE') {
    super(message);
    this.code = code;
  }
}

/** Textes soumis au visiteur. La version est tracee comme preuve (RGPD). */
export const TEXTES = {
  CGU: { type: 'CGU', version: '1.0' },
  DECHARGE: { type: 'DECHARGE_PESANTEUR', version: '1.0' },
};

/** Occupation de la salle a cet instant, telle que le capteur la voit. */
export function occupationSalle() {
  return Math.max(0, dernierReleve().occupation ?? 0);
}

/* ======================================================================== */
/* Identite et consentements                                                */
/* ======================================================================== */

/**
 * Enregistre (ou retrouve) un visiteur a partir de son e-mail.
 * Le statut de priorite n'est jamais choisi ici : il vient de la billetterie.
 */
export function enregistrerVisiteur(email) {
  const s = etat();
  const normalise = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalise)) {
    throw new ErreurMetier('Adresse e-mail invalide', 'EMAIL_INVALIDE');
  }

  const existant = Object.values(s.visiteurs).find((v) => v.email === normalise);
  if (existant) return existant;

  const billet = chercherBillet(normalise);
  const id = nouvelId('vis');
  publier('VISITEUR_ENREGISTRE', { visiteurId: id, email: normalise, ...billet });
  return etat().visiteurs[id];
}

/** F-01 : consentement et decharge « plusieurs G », traces avec leur version. */
export function donnerConsentements(visiteurId, { cgu, decharge }) {
  const v = exigerVisiteur(visiteurId);
  if (!cgu || !decharge) {
    throw new ErreurMetier('Les conditions et la décharge doivent être acceptées', 'CONSENTEMENT_MANQUANT');
  }
  for (const texte of [TEXTES.CGU, TEXTES.DECHARGE]) {
    if (!v.consentements.some((c) => c.type === texte.type && c.version === texte.version)) {
      publier('CONSENTEMENT_RECUEILLI', {
        visiteurId, typeConsentement: texte.type, version: texte.version,
      });
    }
  }
  return etat().visiteurs[visiteurId];
}

/**
 * F-02 : l'auto-declaration d'aptitude est convertie en booleen.
 * La reponse detaillee n'entre jamais dans le systeme : le front n'envoie que
 * « apte » ou « non apte ».
 */
export function declarerAptitude(visiteurId, apte) {
  exigerVisiteur(visiteurId);
  publier('APTITUDE_DECLAREE', { visiteurId, apte: !!apte });
  return etat().visiteurs[visiteurId];
}

/**
 * Correction par l'administrateur des informations d'un visiteur : prenom,
 * initiale, statut, aptitude. L'e-mail (identifiant de connexion) et la
 * reference de billet ne se modifient pas ici.
 *
 * Le statut modifie vaut pour les prochaines inscriptions : un ticket deja
 * cree garde le statut avec lequel il a ete pris.
 */
export function modifierVisiteur(visiteurId, champs = {}, acteur = 'admin') {
  const v = exigerVisiteur(visiteurId);
  const regles = etat().regles;
  const modifications = {};

  if (champs.prenom !== undefined) {
    const prenom = String(champs.prenom).trim();
    if (!prenom) throw new ErreurMetier('Le prénom ne peut pas être vide', 'CHAMP_INVALIDE');
    modifications.prenom = prenom;
  }
  if (champs.initiale !== undefined) {
    const initiale = String(champs.initiale).trim();
    if (!initiale || initiale.length > 3) {
      throw new ErreurMetier("L'initiale doit faire de 1 à 3 caractères", 'CHAMP_INVALIDE');
    }
    modifications.initiale = initiale;
  }
  if (champs.statut !== undefined) {
    if (!regles.statuts[champs.statut]) throw new ErreurMetier('Statut inconnu', 'CHAMP_INVALIDE');
    modifications.statut = champs.statut;
  }
  if (champs.apte !== undefined && champs.apte !== null) {
    modifications.apte = !!champs.apte;
  }

  // On ne trace que ce qui change vraiment.
  for (const [cle, valeur] of Object.entries(modifications)) {
    if (v[cle] === valeur) delete modifications[cle];
  }
  if (!Object.keys(modifications).length) return v;

  const details = `${visiteurId} : ${Object.entries(modifications)
    .map(([cle, valeur]) => `${cle}=${valeur}`).join(', ')}`;
  publier('VISITEUR_MODIFIE', { visiteurId, modifications, acteur, details });
  return etat().visiteurs[visiteurId];
}

/* ======================================================================== */
/* Ouverture des inscriptions (RG-01, RG-04, RG-07)                         */
/* ======================================================================== */

/**
 * Determine si les inscriptions sont ouvertes pour un statut donne.
 *
 * L'attente comparee aux horaires est l'attente TOTALE : file virtuelle plus
 * traversee de la file reelle. Promettre un passage en oubliant les trente
 * personnes deja debout devant l'attraction reviendrait a mentir d'un quart
 * d'heure au moment ou cela compte le plus, en fin de journee.
 *
 * @returns {{ouvert:boolean, motif:string|null, heureLimite:number|null, estimation:object}}
 */
export function etatInscriptions(state, statut, occupation = occupationSalle(state)) {
  const r = state.regles;
  const minutes = minutesDuJour();
  const estimation = estimer(state, statut, { occupationSalle: occupation });

  if (state.file.etat === 'PURGEE') {
    return { ouvert: false, motif: "L'attraction est fermée pour la journée", heureLimite: null, estimation };
  }
  // RG-01 : la file virtuelle ouvre a 8h00 avec le parc.
  if (minutes < r.ouvertureFile) {
    return { ouvert: false, motif: `Les inscriptions ouvrent à ${enHeure(r.ouvertureFile)}`, heureLimite: null, estimation };
  }
  if (minutes >= r.finExploitation) {
    return { ouvert: false, motif: "L'exploitation est terminée pour aujourd'hui", heureLimite: null, estimation };
  }

  // RG-07 : la garantie Saiyan ne se promet jamais a tort.
  const garantie = r.statuts[statut]?.garantieMin;
  if (garantie !== null && garantie !== undefined && garantie > 0 && estimation.minutes > garantie) {
    return {
      ouvert: false,
      motif: `Attente garantie à ${garantie} min impossible à tenir — inscriptions ${r.statuts[statut].libelle} suspendues`,
      heureLimite: null, estimation,
    };
  }

  // RG-04 : fermeture automatique = 19h00 - attente estimee - marge de securite.
  const heureLimite = r.finExploitation - estimation.minutes - r.margeSecuriteMin;
  if (minutes > heureLimite) {
    return {
      ouvert: false,
      motif: `Plus assez de temps avant ${enHeure(r.finExploitation)} pour garantir le passage`,
      heureLimite, estimation,
    };
  }

  return { ouvert: true, motif: null, heureLimite, estimation };
}

/* ======================================================================== */
/* Inscription et desistement                                               */
/* ======================================================================== */

/**
 * SEULE voie d'entree dans la file (RG-02, RG-03).
 * Appelee uniquement par la route visiteur authentifiee.
 */
export function rejoindreFile(visiteurId) {
  const s = etat();
  const v = exigerVisiteur(visiteurId);

  // RG-02 : consentement + decharge + aptitude + un seul ticket actif.
  const aCgu = v.consentements.some((c) => c.type === TEXTES.CGU.type);
  const aDecharge = v.consentements.some((c) => c.type === TEXTES.DECHARGE.type);
  if (!aCgu || !aDecharge) {
    throw new ErreurMetier('Conditions et décharge non acceptées', 'CONSENTEMENT_MANQUANT');
  }
  if (v.apte !== true) {
    throw new ErreurMetier("Vous avez déclaré ne pas remplir les conditions d'accès", 'NON_APTE');
  }
  if (ticketActifDe(s, visiteurId)) {
    throw new ErreurMetier('Vous avez déjà un ticket en cours', 'TICKET_EXISTANT');
  }

  const inscriptions = etatInscriptions(s, v.statut);
  if (!inscriptions.ouvert) {
    throw new ErreurMetier(inscriptions.motif, 'INSCRIPTIONS_FERMEES');
  }

  const ticketId = nouvelId('tk');
  publier('TICKET_CREE', {
    ticketId,
    visiteurId,
    statut: v.statut,
    rang: s.file.prochainRang,            // RG-03 : rang d'arrivee definitif
    estimationMin: inscriptions.estimation.minutes,
  });

  return etat().tickets[ticketId];
}

/** RG-14 : desistement du visiteur, definitif, revoque le QR immediatement. */
export function seDesister(visiteurId) {
  const s = etat();
  const t = ticketActifDe(s, visiteurId);
  if (!t) throw new ErreurMetier('Aucun ticket actif', 'TICKET_INTROUVABLE');
  publier('TICKET_ANNULE', { ticketId: t.id, motif: 'Désistement du visiteur' });
  return etat().tickets[t.id];
}

/* ======================================================================== */
/* Actions de l'agent (RG-11, RG-12)                                        */
/* ======================================================================== */

/** Retrait par un agent, d'un visiteur encore dans le parc ou en route. */
export function retirerTicket(ticketId, motif, acteur) {
  exigerMotif(motif);
  const t = etat().tickets[ticketId];
  if (!t) throw new ErreurMetier('Ticket introuvable', 'TICKET_INTROUVABLE');
  if (![ETATS_TICKET.EN_ATTENTE, ETATS_TICKET.CONVOQUE].includes(t.etat)) {
    throw new ErreurMetier('Ce ticket n\'est plus actif', 'TICKET_INACTIF');
  }
  publier('TICKET_RETIRE', { ticketId, motif, acteur });
  const v = etat().visiteurs[t.visiteurId];
  if (v) {
    envoyer(v.email, 'Votre place a été retirée',
      `Un agent a retiré votre ticket. Motif : ${motif}. Vous pouvez vous réinscrire depuis l'application.`,
      'RETRAIT');
  }
  return etat().tickets[ticketId];
}

/** Tous les visiteurs dont le ticket est encore actif : dans le parc ou en route. */
function ticketsConcernes(state) {
  return [...ticketsEnAttente(state), ...ticketsConvoques(state)];
}

/** RG-12 : la pause gele tous les compteurs et informe les visiteurs. */
export function mettreEnPause(motif, acteur) {
  exigerMotif(motif);
  const s = etat();
  if (s.file.etat === 'EN_PAUSE') throw new ErreurMetier('La file est déjà en pause', 'DEJA_EN_PAUSE');
  publier('FILE_PAUSEE', { motif, acteur });

  for (const t of ticketsConcernes(etat())) {
    const v = etat().visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'Attraction momentanément interrompue',
        `Motif : ${motif}. Votre place est conservée et tous vos compteurs sont gelés. Nous vous préviendrons à la reprise.`,
        'INCIDENT');
    }
  }
  return etat().file;
}

export function reprendre(acteur) {
  const s = etat();
  if (s.file.etat !== 'EN_PAUSE') throw new ErreurMetier('La file n\'est pas en pause', 'PAS_EN_PAUSE');
  publier('FILE_REPRISE', { acteur });

  for (const t of ticketsConcernes(etat())) {
    const v = etat().visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'Reprise de l\'attraction',
        'L\'attraction redémarre. Vous retrouvez exactement le temps qu\'il vous restait.',
        'INCIDENT');
    }
  }
  return etat().file;
}

/** Purge : arret definitif de la journee, apres double confirmation cote IHM. */
export function purger(motif, acteur) {
  exigerMotif(motif);
  const s = etat();
  const concernes = ticketsConcernes(s);
  publier('FILE_PURGEE', { motif, acteur, nombreTickets: concernes.length });
  for (const t of concernes) {
    publier('TICKET_PURGE', { ticketId: t.id, motif, acteur: 'systeme' });
    const v = etat().visiteurs[t.visiteurId];
    if (v) {
      envoyer(v.email, 'Attraction fermée pour la journée',
        `Motif : ${motif}. Votre ticket a été annulé. Nous sommes désolés pour la gêne occasionnée.`,
        'INCIDENT');
    }
  }
  return { purges: concernes.length };
}

export function rouvrirFile(acteur) {
  publier('FILE_ROUVERTE', { acteur });
  return etat().file;
}

export function ouvrirIncident(typeIncident, motif, acteur) {
  exigerMotif(motif);
  const incidentId = nouvelId('inc');
  publier('INCIDENT_OUVERT', { incidentId, typeIncident, motif, acteur });
  return etat().incidents.at(-1);
}

export function cloreIncident(incidentId, acteur) {
  const i = etat().incidents.find((x) => x.id === incidentId);
  if (!i) throw new ErreurMetier('Incident introuvable', 'INCIDENT_INTROUVABLE');
  publier('INCIDENT_CLOS', { incidentId, acteur });
  return etat().incidents.find((x) => x.id === incidentId);
}

/* ======================================================================== */
/* Le scan (F-08, F-11, RG-09)                                              */
/* ======================================================================== */

/**
 * Verdict de scan. Toujours un verdict explicite et un motif en cas de refus :
 * l'agent doit pouvoir expliquer le refus au visiteur en une phrase.
 *
 * Il n'y a qu'un scan, a l'entree de la file reelle. L'agent verifie le QR
 * code, et c'est tout : un code valide consomme le ticket. L'entree dans la
 * salle est geree ensuite par un second agent, sans application et sans
 * nouvelle verification — c'est lui qui regarde le capteur et laisse entrer.
 *
 * @param {string} jeton
 * @param {string} acteur  agent | admin
 */
export function scanner(jeton, acteur) {
  const s = etat();
  const now = maintenant();
  const scanId = nouvelId('scan');

  const refus = (motif, ticketId = null, extra = {}) => {
    publier('SCAN_ENREGISTRE', { scanId, ticketId, verdict: 'REFUSE', motif, acteur });
    return { verdict: 'REFUSE', motif, ticketId, ...extra };
  };

  if (s.file.etat === 'EN_PAUSE') {
    return refus(`Attraction en pause : ${s.file.motifPause}`);
  }
  if (s.file.etat === 'PURGEE') {
    return refus('Attraction fermée pour la journée');
  }

  const verif = verifierJeton(jeton, s.regles.validiteJetonQrSec);
  if (!verif.valide) return refus(verif.motif);

  const t = s.tickets[verif.ticketId];
  if (!t) return refus('Ticket inconnu', verif.ticketId);

  const v = s.visiteurs[t.visiteurId];
  const identite = v ? { prenom: v.prenom, initiale: v.initiale, statut: v.statut } : null;

  // --- Etats qui ne donnent droit a rien ---------------------------------
  if (t.etat === ETATS_TICKET.VALIDE) return refus('Code déjà utilisé', t.id, { visiteur: identite });
  if (t.etat === ETATS_TICKET.EN_ATTENTE) return refus('Visiteur pas encore convoqué', t.id, { visiteur: identite });
  if (t.etat !== ETATS_TICKET.CONVOQUE) {
    return refus({
      ANNULE: 'Ticket annulé par le visiteur',
      RETIRE: 'Ticket retiré par un agent',
      EXPIRE: 'Délai de convocation dépassé',
      PURGE: 'File purgée',
    }[t.etat] ?? 'Ticket inactif', t.id);
  }

  // RG-09 : 10 minutes pour venir, puis un delai de grace. Les pauses ne
  // comptent pas.
  const ecouleSec = tempsActifEcoule(s, t.convoqueA, now) / 1000;
  const limite = s.regles.delaiConvocationSec;
  const limiteAvecGrace = limite + s.regles.delaiGraceSec;

  if (ecouleSec > limiteAvecGrace) {
    publier('TICKET_EXPIRE', { ticketId: t.id, motif: 'Délai de convocation dépassé' });
    return refus('Délai dépassé — le visiteur peut se réinscrire en fin de file', t.id, { visiteur: identite });
  }

  // Rien a verifier sur la capacite de la file reelle : la place a ete
  // reservee des la convocation (RG-16, applique dans l'ordonnanceur).
  const pendantGrace = ecouleSec > limite;
  const motif = pendantGrace ? 'Accepté pendant le délai de grâce' : null;
  publier('SCAN_ENREGISTRE', { scanId, ticketId: t.id, verdict: 'ACCEPTE', acteur, motif });
  publier('TICKET_VALIDE', { ticketId: t.id, pendantGrace, acteur });

  return {
    verdict: 'ACCEPTE',
    ticketId: t.id,
    // Affiche a l'agent pour le controle visuel de la piece d'identite.
    visiteur: identite,
    pendantGrace,
    motif,
  };
}

/* ======================================================================== */
/* Configuration a chaud (RG-15 / F-16)                                     */
/* ======================================================================== */

export function modifierRegles(valeurs, acteur) {
  publier('REGLES_MODIFIEES', { regles: valeurs, acteur, motif: Object.keys(valeurs).join(', ') });
  return etat().regles;
}

/* ======================================================================== */
/* Utilitaires internes                                                     */
/* ======================================================================== */

function exigerVisiteur(visiteurId) {
  const v = etat().visiteurs[visiteurId];
  if (!v) throw new ErreurMetier('Visiteur inconnu', 'VISITEUR_INTROUVABLE');
  return v;
}

function exigerMotif(motif) {
  // RG-11 : toute action d'operateur exige un motif, sans exception.
  if (!motif || String(motif).trim().length < 3) {
    throw new ErreurMetier('Un motif est obligatoire', 'MOTIF_MANQUANT');
  }
}

export function enHeure(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}`;
}

export { timestampDuJour, comparerOrdrePassage };
