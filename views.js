/**
 * ---------------------------------------------------------------------------
 * VUES DE LECTURE
 * ---------------------------------------------------------------------------
 * Le domaine expose des commandes (ecriture) ; ce fichier expose des vues
 * (lecture). Cette separation evite que l'IHM aille fouiller dans l'etat
 * interne et permet de faire evoluer l'un sans casser l'autre.
 *
 * Aucune vue ne modifie l'etat.
 * ---------------------------------------------------------------------------
 */

import { etatHorloge, maintenant, formatHeure, minutesDuJour, timestampDuJour } from '../domain/clock.js';
import {
  ETATS_TICKET, ticketsEnAttente, ticketsConvoques, tempsActifEcoule, comparerOrdrePassage,
} from '../domain/state.js';
import { estimer, estimerTousStatuts, debitNominal } from '../domain/estimator.js';
import { etatInscriptions, enHeure } from '../domain/commands.js';
import { cycleCourant, minutesAvantProchainCycle, comptageCycle, resteGarantieMin } from '../domain/scheduler.js';
import { dernierReleve } from '../infra/sensor.js';

/* ------------------------------------------------------------------------ */
/* Vue « file » : partagee par les trois interfaces et poussee en SSE        */
/* ------------------------------------------------------------------------ */

export function vueFile(state) {
  const r = state.regles;
  const capteur = dernierReleve();
  const cycle = cycleCourant(state);
  const compte = comptageCycle(state, cycle);

  const inscriptions = {};
  for (const code of Object.keys(r.statuts)) {
    const e = etatInscriptions(state, code, capteur.occupation);
    inscriptions[code] = {
      ouvert: e.ouvert,
      motif: e.motif,
      heureLimite: e.heureLimite === null ? null : enHeure(e.heureLimite),
    };
  }

  const tickets = Object.values(state.tickets);
  return {
    horloge: etatHorloge(),
    file: {
      id: state.file.id,
      nom: state.file.nom,
      etat: state.file.etat,
      motifPause: state.file.motifPause,
      ouvertureFile: enHeure(r.ouvertureFile),
      debutExploitation: enHeure(r.debutExploitation),
      finExploitation: enHeure(r.finExploitation),
      enExploitation:
        state.file.etat === 'OUVERTE'
        && minutesDuJour() >= r.debutExploitation
        && minutesDuJour() < r.finExploitation,
    },
    statuts: r.statuts,
    attente: estimerTousStatuts(state, capteur.occupation),
    inscriptions,
    capteur: {
      occupation: capteur.occupation,
      capacite: r.capaciteSalleAttente,
      source: capteur.source,
      erreur: capteur.erreur,
      age: capteur.ts ? Math.round((maintenant() - capteur.ts) / 1000) : null,
    },
    cycle: {
      index: cycle,
      placesParCycle: r.placesParCycle,
      placesConsommees: compte.total,
      minutesAvantProchain: Math.round(minutesAvantProchainCycle(state)),
      debitNominal: debitNominal(r),
    },
    compteurs: {
      enAttente: ticketsEnAttente(state).length,
      convoques: ticketsConvoques(state).length,
      entres: tickets.filter((t) => t.etat === ETATS_TICKET.ENTRE).length,
      expires: tickets.filter((t) => t.etat === ETATS_TICKET.EXPIRE).length,
      desistements: tickets.filter((t) => t.etat === ETATS_TICKET.ANNULE).length,
      parStatut: repartition(ticketsEnAttente(state)),
    },
    incidentOuvert: state.incidents.find((i) => i.fin === null) ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* Vue « mon ticket »                                                        */
/* ------------------------------------------------------------------------ */

export function vueTicket(state, ticket) {
  if (!ticket) return null;
  const r = state.regles;
  const now = maintenant();
  const capteur = dernierReleve();

  const base = {
    id: ticket.id,
    statut: ticket.statut,
    libelleStatut: r.statuts[ticket.statut]?.libelle ?? ticket.statut,
    etat: ticket.etat,
    rang: ticket.rang,
    creeA: ticket.creeA,
    heureInscription: formatHeure(ticket.creeA),
    motif: ticket.motif,
    avertiFinJournee: ticket.avertiFinJournee,
  };

  if (ticket.etat === ETATS_TICKET.EN_ATTENTE) {
    const attente = ticketsEnAttente(state);
    const position = attente.findIndex((t) => t.id === ticket.id) + 1;
    const est = estimer(state, ticket.statut, { rang: ticket.rang, occupationSalle: capteur.occupation });
    const garantie = resteGarantieMin(state, ticket, now);
    return {
      ...base,
      position,
      devant: est.devant,
      estimation: est,
      heurePrevisionnelle: formatHeure(now + est.minutes * 60_000),
      resteGarantieMin: garantie === null ? null : Math.round(garantie),
      geleParPause: state.file.etat === 'EN_PAUSE',
    };
  }

  if (ticket.etat === ETATS_TICKET.CONVOQUE) {
    const ecouleSec = tempsActifEcoule(state, ticket.convoqueA, now) / 1000;
    const resteSec = Math.max(0, r.delaiConvocationSec - ecouleSec);
    const resteGraceSec = Math.max(0, r.delaiConvocationSec + r.delaiGraceSec - ecouleSec);
    return {
      ...base,
      convoqueA: ticket.convoqueA,
      resteSec: Math.round(resteSec),
      resteGraceSec: Math.round(resteGraceSec),
      enGrace: resteSec === 0 && resteGraceSec > 0,
      geleParPause: state.file.etat === 'EN_PAUSE',
    };
  }

  return base;
}

/* ------------------------------------------------------------------------ */
/* Vue « file detaillee » pour la console agent                              */
/* ------------------------------------------------------------------------ */

export function vueFileAgent(state) {
  const now = maintenant();
  const r = state.regles;
  const lignes = Object.values(state.tickets)
    .filter((t) => [ETATS_TICKET.EN_ATTENTE, ETATS_TICKET.CONVOQUE].includes(t.etat))
    .sort(comparerOrdrePassage(state))
    .map((t, i) => {
      const v = state.visiteurs[t.visiteurId] ?? {};
      const ecouleSec = t.convoqueA ? tempsActifEcoule(state, t.convoqueA, now) / 1000 : null;
      return {
        position: i + 1,
        id: t.id,
        rang: t.rang,
        etat: t.etat,
        statut: t.statut,
        libelleStatut: r.statuts[t.statut]?.libelle ?? t.statut,
        visiteur: `${v.prenom ?? '?'} ${v.initiale ?? ''}.`,
        heureInscription: formatHeure(t.creeA),
        resteConvocationSec: ecouleSec === null ? null
          : Math.max(0, Math.round(r.delaiConvocationSec + r.delaiGraceSec - ecouleSec)),
        resteGarantieMin: (() => {
          const g = resteGarantieMin(state, t, now);
          return g === null ? null : Math.round(g);
        })(),
      };
    });
  return lignes;
}

/* ------------------------------------------------------------------------ */
/* Vue « metriques » pour le tableau de bord (F-15)                          */
/* ------------------------------------------------------------------------ */

export function vueMetriques(state) {
  const r = state.regles;
  const tickets = Object.values(state.tickets);
  const entres = tickets.filter((t) => t.etat === ETATS_TICKET.ENTRE);
  const expires = tickets.filter((t) => t.etat === ETATS_TICKET.EXPIRE);
  const annules = tickets.filter((t) => t.etat === ETATS_TICKET.ANNULE);
  const capteur = dernierReleve();

  // Attente reelle vecue par les visiteurs deja entres, par statut.
  const reelsParStatut = {};
  for (const t of entres) {
    const reelMin = tempsActifEcoule(state, t.creeA, t.entreA) / 60_000;
    (reelsParStatut[t.statut] ??= []).push(reelMin);
  }

  const attentes = {};
  for (const code of Object.keys(r.statuts)) {
    const serie = reelsParStatut[code] ?? [];
    attentes[code] = {
      libelle: r.statuts[code].libelle,
      actuelMin: estimer(state, code, { occupationSalle: capteur.occupation }).minutes,
      moyenneMin: arrondi(moyenne(serie)),
      p90Min: arrondi(centile(serie, 90)),
      passages: serie.length,
    };
  }

  // Ecart entre attente annoncee a l'inscription et attente reellement vecue.
  const ecarts = entres
    .map((t) => {
      const reel = tempsActifEcoule(state, t.creeA, t.entreA) / 60_000;
      if (reel < 1) return null;
      return Math.abs(t.estimationInitialeMin - reel) / reel;
    })
    .filter((x) => x !== null);

  // Garantie Saiyan : part des Saiyans entres dans les 30 minutes promises.
  const saiyans = entres.filter((t) => t.statut === 'SAIYAN');
  const garantieTenue = saiyans.filter(
    (t) => tempsActifEcoule(state, t.creeA, t.entreA) / 60_000 <= (r.statuts.SAIYAN.garantieMin ?? Infinity),
  ).length;

  // Remplissage : places consommees / places offertes depuis le debut.
  const cycle = cycleCourant(state);
  const cyclesEcoules = Math.max(1, cycle + 1);
  const placesOffertes = cyclesEcoules * r.placesParCycle;

  const dureeIncidentsMin = state.incidents.reduce(
    (somme, i) => somme + ((i.fin ?? maintenant()) - i.debut) / 60_000, 0,
  );

  // Tickets qui ne seront pas servis avant la fermeture.
  const finJour = timestampDuJour(r.finExploitation);
  const nonServis = ticketsEnAttente(state).filter((t) => {
    const est = estimer(state, t.statut, { rang: t.rang, occupationSalle: capteur.occupation });
    return maintenant() + est.minutes * 60_000 > finJour;
  }).length;

  return {
    remplissage: {
      attractionPct: arrondi((entres.length / placesOffertes) * 100),
      sallePct: arrondi((capteur.occupation / r.capaciteSalleAttente) * 100),
      occupationSalle: capteur.occupation,
      capaciteSalle: r.capaciteSalleAttente,
    },
    attentes,
    garantieSaiyanPct: saiyans.length ? arrondi((garantieTenue / saiyans.length) * 100) : 100,
    ecartAnnonceReelPct: ecarts.length ? arrondi(moyenne(ecarts) * 100) : 0,
    absences: {
      tauxPct: entres.length + expires.length
        ? arrondi((expires.length / (entres.length + expires.length)) * 100) : 0,
      nombre: expires.length,
      // « Present mais non scanne » : refus de scan hors du cas « deja utilise ».
      refusScan: state.scans.filter((s) => s.verdict === 'REFUSE').length,
    },
    repartitionPassages: repartition(entres),
    incidents: { nombre: state.incidents.length, dureeCumuleeMin: arrondi(dureeIncidentsMin) },
    finDeJournee: {
      ticketsNonServis: nonServis,
      tauxDesistementPct: tickets.length ? arrondi((annules.length / tickets.length) * 100) : 0,
    },
    totaux: {
      inscrits: tickets.length,
      entres: entres.length,
      expires: expires.length,
      annules: annules.length,
      enAttente: ticketsEnAttente(state).length,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Utilitaires                                                               */
/* ------------------------------------------------------------------------ */

function repartition(liste) {
  const out = {};
  for (const t of liste) out[t.statut] = (out[t.statut] || 0) + 1;
  return out;
}

function moyenne(serie) {
  if (!serie.length) return 0;
  return serie.reduce((a, b) => a + b, 0) / serie.length;
}

function centile(serie, p) {
  if (!serie.length) return 0;
  const trie = [...serie].sort((a, b) => a - b);
  const i = Math.min(trie.length - 1, Math.floor((p / 100) * trie.length));
  return trie[i];
}

function arrondi(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
