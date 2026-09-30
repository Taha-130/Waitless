/**
 * ---------------------------------------------------------------------------
 * ETAT DU DOMAINE + REDUCTEUR D'EVENEMENTS
 * ---------------------------------------------------------------------------
 * Principe : l'etat de la file n'est jamais modifie directement. Toute
 * modification passe par un EVENEMENT ajoute au journal, puis applique ici.
 *
 * Consequence directe, et c'est tout l'interet : au demarrage on relit le
 * journal et on rejoue `appliquer()` evenement par evenement. On retrouve
 * exactement l'etat d'avant l'arret, rangs compris. C'est la traduction
 * technique de RG-13 et F-13 (« redemarrage sans perte de position »).
 *
 * Ce fichier ne fait AUCUN controle de regle : il se contente d'appliquer des
 * faits deja valides. Les controles sont dans commands.js.
 * ---------------------------------------------------------------------------
 */

import { REGLES_PAR_DEFAUT } from '../config/rules.js';

/**
 * Etats possibles d'un ticket, dans l'ordre du parcours reel :
 *
 *   EN_ATTENTE ──convocation──> CONVOQUE ──scan──> VALIDE
 *                                   │
 *                                   └──delai depasse──> EXPIRE
 *
 * Il n'y a qu'UN scan, a l'entree de la file reelle. L'agent y verifie le QR
 * code : le ticket est alors VALIDE, et consomme. Un second agent, sans
 * application, fait ensuite entrer les visiteurs dans la salle, sans nouvelle
 * verification. Le systeme ne sait donc pas qui est encore dans la file reelle
 * et qui est deja dans la salle : pour lui, le parcours s'arrete au scan.
 */
export const ETATS_TICKET = {
  EN_ATTENTE: 'EN_ATTENTE',
  CONVOQUE: 'CONVOQUE',
  VALIDE: 'VALIDE',   // QR scanne a l'entree de la file reelle, code consomme
  EXPIRE: 'EXPIRE',
  ANNULE: 'ANNULE',   // desistement du visiteur (RG-14)
  RETIRE: 'RETIRE',   // retrait par l'agent (RG-11)
  PURGE: 'PURGE',     // purge de la file
};

/** Un ticket « vivant » : dans le parc, ou convoque et en route. */
export const ETATS_ACTIFS = [
  ETATS_TICKET.EN_ATTENTE,
  ETATS_TICKET.CONVOQUE,
];

export function etatInitial() {
  return {
    jour: null,
    file: {
      id: 'salle-du-temps',
      nom: 'La Salle du Temps',
      etat: 'OUVERTE',              // OUVERTE | EN_PAUSE | PURGEE
      prochainRang: 1,              // RG-03 : compteur strictement croissant
      pauses: [],                   // [{debut, fin, motif}] -> gel des compteurs
      motifPause: null,
    },
    regles: structuredClone(REGLES_PAR_DEFAUT),
    visiteurs: {},                  // id -> visiteur
    tickets: {},                    // id -> ticket
    incidents: [],
    scans: [],
    audit: [],                      // actions des operateurs (12 mois)
    dernierSeq: 0,
  };
}

/**
 * Applique un evenement a l'etat. Fonction pure et deterministe : c'est ce qui
 * garantit qu'un rejeu du journal redonne le meme etat.
 */
export function appliquer(state, ev) {
  state.dernierSeq = Math.max(state.dernierSeq, ev.seq || 0);
  if (ev.jour && !state.jour) state.jour = ev.jour;

  switch (ev.type) {
    case 'REGLES_MODIFIEES': {
      // Fusion superficielle + fusion du referentiel des statuts.
      const { statuts, ...reste } = ev.regles;
      Object.assign(state.regles, reste);
      if (statuts) {
        for (const [code, valeur] of Object.entries(statuts)) {
          state.regles.statuts[code] = { ...state.regles.statuts[code], ...valeur };
        }
      }
      break;
    }

    case 'VISITEUR_ENREGISTRE': {
      state.visiteurs[ev.visiteurId] = {
        id: ev.visiteurId,
        email: ev.email,
        prenom: ev.prenom,
        initiale: ev.initiale,
        statut: ev.statut,
        refBillet: ev.refBillet,
        anneeNaissance: ev.anneeNaissance ?? null,
        apte: null,                 // F-02 : statut derive, jamais la donnee source
        consentements: [],
        creeA: ev.ts,
      };
      break;
    }

    case 'CONSENTEMENT_RECUEILLI': {
      const v = state.visiteurs[ev.visiteurId];
      if (v) v.consentements.push({ type: ev.typeConsentement, version: ev.version, date: ev.ts });
      break;
    }

    case 'APTITUDE_DECLAREE': {
      const v = state.visiteurs[ev.visiteurId];
      if (v) v.apte = ev.apte;
      break;
    }

    // Correction des informations d'un visiteur par l'administrateur.
    case 'VISITEUR_MODIFIE': {
      const v = state.visiteurs[ev.visiteurId];
      if (v) Object.assign(v, ev.modifications);
      break;
    }

    case 'VISITEUR_EFFACE': {
      // RGPD, droit a l'effacement. On ne supprime pas la ligne du journal
      // (elle serait irrecuperable pour la reprise) : on efface les donnees
      // nominatives au rejeu. Le ticket et son rang survivent, anonymises.
      const v = state.visiteurs[ev.visiteurId];
      if (v) {
        v.email = `efface-${ev.visiteurId}@invalide`;
        v.prenom = 'Visiteur';
        v.initiale = '-';
        v.anneeNaissance = null;
        v.efface = true;
      }
      break;
    }

    case 'TICKET_CREE': {
      state.tickets[ev.ticketId] = {
        id: ev.ticketId,
        visiteurId: ev.visiteurId,
        statut: ev.statut,
        rang: ev.rang,              // RG-03 : immuable, jamais reecrit
        etat: ETATS_TICKET.EN_ATTENTE,
        creeA: ev.ts,
        estimationInitialeMin: ev.estimationMin,
        convoqueA: null,            // appel vers la file reelle
        rappeleA: null,
        valideA: null,              // scan a l'entree de la file reelle
        termineA: null,
        avertiFinJournee: false,
        motif: null,
      };
      state.file.prochainRang = Math.max(state.file.prochainRang, ev.rang + 1);
      break;
    }

    case 'TICKET_CONVOQUE': {
      const t = state.tickets[ev.ticketId];
      if (t) {
        t.etat = ETATS_TICKET.CONVOQUE;
        t.convoqueA = ev.ts;
      }
      break;
    }

    case 'RAPPEL_ENVOYE': {
      const t = state.tickets[ev.ticketId];
      if (t) t.rappeleA = ev.ts;
      break;
    }

    case 'VIGILANCE_ENVOYEE': {
      const t = state.tickets[ev.ticketId];
      if (t) t.avertiFinJournee = true;   // F-07 : une seule fois par ticket
      break;
    }

    // Le scan : le visiteur convoque est arrive a l'entree de la file reelle.
    // Son code est consomme ; il ne peut plus expirer (RG-10).
    case 'TICKET_VALIDE': {
      const t = state.tickets[ev.ticketId];
      if (t) {
        t.etat = ETATS_TICKET.VALIDE;
        t.valideA = ev.ts;
        t.termineA = ev.ts;
        t.pendantGrace = !!ev.pendantGrace;
      }
      break;
    }

    case 'TICKET_EXPIRE':
    case 'TICKET_ANNULE':
    case 'TICKET_RETIRE':
    case 'TICKET_PURGE': {
      const t = state.tickets[ev.ticketId];
      if (t) {
        t.etat = {
          TICKET_EXPIRE: ETATS_TICKET.EXPIRE,
          TICKET_ANNULE: ETATS_TICKET.ANNULE,
          TICKET_RETIRE: ETATS_TICKET.RETIRE,
          TICKET_PURGE: ETATS_TICKET.PURGE,
        }[ev.type];
        t.termineA = ev.ts;
        t.motif = ev.motif ?? null;
      }
      break;
    }

    case 'FILE_PAUSEE': {
      state.file.etat = 'EN_PAUSE';
      state.file.motifPause = ev.motif;
      state.file.pauses.push({ debut: ev.ts, fin: null, motif: ev.motif });
      break;
    }

    case 'FILE_REPRISE': {
      state.file.etat = 'OUVERTE';
      state.file.motifPause = null;
      const derniere = state.file.pauses[state.file.pauses.length - 1];
      if (derniere && derniere.fin === null) derniere.fin = ev.ts;
      break;
    }

    case 'FILE_PURGEE': {
      state.file.etat = 'PURGEE';
      break;
    }

    case 'FILE_ROUVERTE': {
      state.file.etat = 'OUVERTE';
      break;
    }

    case 'INCIDENT_OUVERT': {
      state.incidents.push({
        id: ev.incidentId, type: ev.typeIncident, motif: ev.motif,
        debut: ev.ts, fin: null, acteur: ev.acteur,
      });
      break;
    }

    case 'INCIDENT_CLOS': {
      const i = state.incidents.find((x) => x.id === ev.incidentId);
      if (i) i.fin = ev.ts;
      break;
    }

    case 'SCAN_ENREGISTRE': {
      state.scans.push({
        id: ev.scanId, ticketId: ev.ticketId ?? null, verdict: ev.verdict,
        etape: ev.etape ?? null, motif: ev.motif ?? null, agent: ev.acteur, ts: ev.ts,
      });
      break;
    }

    default:
      // Evenement inconnu : ignore, pour rester tolerant a un journal plus recent.
      break;
  }

  // Journal d'audit : toute action portant un acteur operateur est tracee.
  if (ev.acteur && ev.acteur !== 'systeme') {
    state.audit.push({
      ts: ev.ts, acteur: ev.acteur, action: ev.type,
      details: ev.motif ?? ev.details ?? ev.ticketId ?? ev.verdict ?? '',
    });
  }

  return state;
}

/* ------------------------------------------------------------------------ */
/* Selecteurs : lectures partagees par l'ordonnanceur, l'API et l'estimateur  */
/* ------------------------------------------------------------------------ */

/** Tickets encore dans le parcours, tries par ordre de passage theorique. */
export function ticketsActifs(state) {
  return Object.values(state.tickets)
    .filter((t) => ETATS_ACTIFS.includes(t.etat))
    .sort(comparerOrdrePassage(state));
}

/** Etage 1 : la file virtuelle. Tries par priorite puis par rang d'arrivee. */
export function ticketsEnAttente(state) {
  return Object.values(state.tickets)
    .filter((t) => t.etat === ETATS_TICKET.EN_ATTENTE)
    .sort(comparerOrdrePassage(state));
}

/** Convoques, en route vers la file reelle : leur place y est deja reservee. */
export function ticketsConvoques(state) {
  return Object.values(state.tickets).filter((t) => t.etat === ETATS_TICKET.CONVOQUE);
}

/** Tickets scannes a l'entree de la file reelle, dans l'ordre du scan. */
export function ticketsValides(state) {
  return Object.values(state.tickets)
    .filter((t) => t.etat === ETATS_TICKET.VALIDE)
    .sort((a, b) => a.valideA - b.valideA);
}

/* ------------------------------------------------------------------------ */
/* Etage 3 : la Salle du Temps                                               */
/* ------------------------------------------------------------------------ */

/**
 * Duree de sejour supposee d'un visiteur, en secondes.
 *
 * Les visiteurs sortent quand ils veulent : le systeme ne le sait pas, seul le
 * capteur le voit. Cette fonction ne sert donc QUE de repli quand aucun capteur
 * n'est branche, pour que la demonstration reste vivante (la salle se vide
 * toute seule). On repartit les durees sur la plage min-max (30 s a 2 min) de
 * facon deterministe — derivee de l'identifiant du ticket — afin que le rejeu
 * du journal redonne exactement le meme etat (RG-13).
 */
export function dureeSejourSupposeeSec(state, ticket) {
  const { dureeSejourMinSec: min, dureeSejourMaxSec: max } = state.regles;
  return min + (max - min) * fractionStable(ticket.id);
}

function fractionStable(texte) {
  let h = 0;
  for (let i = 0; i < String(texte).length; i++) {
    h = (Math.imul(h, 31) + String(texte).charCodeAt(i)) >>> 0;
  }
  return (h % 1000) / 1000;
}

/**
 * Occupation estimee de la salle, utilisee UNIQUEMENT comme repli du capteur.
 * Des qu'une URL de capteur est configuree, c'est le capteur qui fait foi.
 *
 * L'entree dans la salle n'etant pas scannee, on prend l'heure du scan comme
 * heure d'entree approximative, et on borne a la capacite de la salle.
 */
export function occupationSalleEstimee(state, maintenantMs) {
  const presents = Object.values(state.tickets).filter(
    (t) => t.etat === ETATS_TICKET.VALIDE
      && tempsActifEcoule(state, t.valideA, maintenantMs) < dureeSejourSupposeeSec(state, t) * 1000,
  ).length;
  return Math.min(state.regles.capaciteSalle, presents);
}

/**
 * Ordre de passage dans la FILE VIRTUELLE : d'abord le rang de priorite du
 * statut, puis le rang d'arrivee. Le rang d'arrivee n'est jamais modifie
 * (RG-03) ; seule la lecture de la file change selon la priorite.
 */
export function comparerOrdrePassage(state) {
  return (a, b) => {
    const ra = state.regles.statuts[a.statut]?.rang ?? 99;
    const rb = state.regles.statuts[b.statut]?.rang ?? 99;
    return ra - rb || a.rang - b.rang;
  };
}

/** Ticket actif d'un visiteur (RG-02 : un seul a la fois). */
export function ticketActifDe(state, visiteurId) {
  return Object.values(state.tickets).find(
    (t) => t.visiteurId === visiteurId && ETATS_ACTIFS.includes(t.etat),
  );
}

/**
 * Ticket actif s'il y en a un, sinon le dernier de la journee.
 *
 * Sert aux ecrans du visiteur, et a rien d'autre : sans cela, quelqu'un dont
 * le code vient d'etre scanne — ou dont la convocation a expire — verrait son
 * ticket disparaitre sans un mot, et se demanderait si son passage a bien ete
 * enregistre. Les regles, elles, continuent de ne regarder que le ticket ACTIF.
 */
export function dernierTicketDe(state, visiteurId) {
  return ticketActifDe(state, visiteurId)
    ?? Object.values(state.tickets)
      .filter((t) => t.visiteurId === visiteurId)
      .sort((a, b) => b.creeA - a.creeA)[0];
}

/* ------------------------------------------------------------------------ */
/* Gel des compteurs pendant une pause (RG-12)                               */
/* ------------------------------------------------------------------------ */

/** Millisecondes de pause comprises dans l'intervalle [debut, fin]. */
export function msEnPause(state, debut, fin) {
  let total = 0;
  for (const p of state.file.pauses) {
    const d = Math.max(p.debut, debut);
    const f = Math.min(p.fin ?? fin, fin);
    if (f > d) total += f - d;
  }
  return total;
}

/**
 * Temps « actif » ecoule depuis un instant : le temps mur moins les pauses.
 * Tous les delais metier (convocation, grace, garantie Saiyan) sont mesures
 * avec cette fonction, ce qui gele automatiquement les compteurs en pause et
 * les restitue a l'identique a la reprise.
 */
export function tempsActifEcoule(state, depuis, maintenantMs) {
  if (depuis == null) return 0;
  return Math.max(0, maintenantMs - depuis - msEnPause(state, depuis, maintenantMs));
}