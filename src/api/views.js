/**
 * ---------------------------------------------------------------------------
 * VUES DE LECTURE
 * ---------------------------------------------------------------------------
 * Le domaine expose des commandes (ecriture) ; ce fichier expose des vues
 * (lecture). Cette separation evite que l'IHM aille fouiller dans l'etat
 * interne et permet de faire evoluer l'un sans casser l'autre.
 *
 * Aucune vue ne modifie l'etat.
 *
 * Toutes les vues distinguent explicitement les trois etages : file virtuelle,
 * file reelle, salle. La salle est comptee par le capteur ; la file reelle est
 * une estimation, puisque l'entree dans la salle n'est pas scannee.
 * ---------------------------------------------------------------------------
 */

import { etatHorloge, maintenant, formatHeure, minutesDuJour, timestampDuJour } from '../domain/clock.js';
import {
  ETATS_TICKET, ticketsEnAttente, ticketsConvoques, tempsActifEcoule,
} from '../domain/state.js';
import {
  estimer, estimerTousStatuts, nombreDevantReel, debitNominal,
  ticketsFileReelle, occupationFileReelle, placesFileReelle,
} from '../domain/estimator.js';
import { etatInscriptions, enHeure, occupationSalle } from '../domain/commands.js';
import { resteGarantieMin } from '../domain/scheduler.js';
import { dernierReleve } from '../infra/sensor.js';
import { dureeSejourMoyenneSec } from '../config/rules.js';

/* ------------------------------------------------------------------------ */
/* Vue « file » : partagee par les trois interfaces et poussee en SSE        */
/* ------------------------------------------------------------------------ */

export function vueFile(state) {
  const r = state.regles;
  const capteur = dernierReleve();
  const occupation = occupationSalle(state);

  const inscriptions = {};
  for (const code of Object.keys(r.statuts)) {
    const e = etatInscriptions(state, code, occupation);
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
    attente: estimerTousStatuts(state, occupation),
    inscriptions,
    delais: {
      convocationMin: Math.round(r.delaiConvocationSec / 60),
      graceMin: Math.round(r.delaiGraceSec / 60),
    },

    // Etage 3 : la Salle du Temps, telle que le capteur la voit.
    salle: {
      occupation,
      capacite: r.capaciteSalle,
      places: Math.max(0, r.capaciteSalle - occupation),
      pleine: occupation >= r.capaciteSalle,
      source: capteur.source,
      erreur: capteur.erreur,
      age: capteur.ts ? Math.round((maintenant() - capteur.ts) / 1000) : null,
      dureeSejourMinSec: r.dureeSejourMinSec,
      dureeSejourMaxSec: r.dureeSejourMaxSec,
      dureeSejourMoyenneSec: dureeSejourMoyenneSec(r),
      debitNominal: Math.round(debitNominal(r)),
    },

    // Etage 2 : la file physique devant l'attraction. `presents` est estime :
    // on sait qui a ete scanne, pas qui est deja entre dans la salle.
    fileReelle: {
      presents: ticketsFileReelle(state).length,
      enRoute: ticketsConvoques(state).length,
      occupation: occupationFileReelle(state),
      capacite: r.capaciteFileReelle,
      places: placesFileReelle(state),
      pleine: placesFileReelle(state) === 0,
    },

    compteurs: {
      enAttente: ticketsEnAttente(state).length,
      convoques: ticketsConvoques(state).length,
      enFileReelle: ticketsFileReelle(state).length,
      valides: tickets.filter((t) => t.etat === ETATS_TICKET.VALIDE).length,
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
  const occupation = occupationSalle(state);

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
    geleParPause: state.file.etat === 'EN_PAUSE',
  };

  /* --- Etage 1 : file virtuelle, le visiteur profite du parc ------------- */
  if (ticket.etat === ETATS_TICKET.EN_ATTENTE) {
    const attente = ticketsEnAttente(state);
    const position = attente.findIndex((t) => t.id === ticket.id) + 1;
    const est = estimer(state, ticket.statut, { rang: ticket.rang, occupationSalle: occupation });
    const garantie = resteGarantieMin(state, ticket, now);
    return {
      ...base,
      position,
      devant: est.devant,
      devantVirtuel: est.devantVirtuel,
      devantReel: est.devantReel,
      estimation: est,
      heurePrevisionnelle: formatHeure(now + est.minutes * 60_000),
      resteGarantieMin: garantie === null ? null : Math.round(garantie),
    };
  }

  /* --- Etage 1 bis : convoque, en route vers la file reelle -------------- */
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
      // Ce qui l'attend a l'arrivee, pour qu'il ne coure pas pour rien.
      devantFileReelle: ticketsFileReelle(state).length,
      placesSalle: Math.max(0, r.capaciteSalle - occupation),
    };
  }

  /* --- Code scanne a l'entree de la file reelle : fin du parcours suivi --- */
  if (ticket.etat === ETATS_TICKET.VALIDE) {
    return { ...base, valideA: ticket.valideA, heureValidation: formatHeure(ticket.valideA) };
  }

  return base;
}

/* ------------------------------------------------------------------------ */
/* Vue « file detaillee » pour la console agent                              */
/* ------------------------------------------------------------------------ */

/**
 * L'agent voit les tickets encore actifs : ceux qui sont en route vers la file
 * reelle, puis la file virtuelle. C'est l'ordre dans lequel il les
 * rencontrera. Une fois scanne, un visiteur sort de la liste : le systeme ne
 * sait pas s'il attend encore ou s'il est deja dans la salle.
 */
export function vueFileAgent(state) {
  const now = maintenant();
  const r = state.regles;

  const ligne = (t, zone, position) => {
    const v = state.visiteurs[t.visiteurId] ?? {};
    const ecouleSec = t.convoqueA ? tempsActifEcoule(state, t.convoqueA, now) / 1000 : null;
    const g = resteGarantieMin(state, t, now);
    return {
      position,
      zone,                                  // EN_ROUTE | VIRTUELLE
      id: t.id,
      rang: t.rang,
      etat: t.etat,
      statut: t.statut,
      libelleStatut: r.statuts[t.statut]?.libelle ?? t.statut,
      visiteur: `${v.prenom ?? '?'} ${v.initiale ?? ''}.`,
      heureInscription: formatHeure(t.creeA),
      resteConvocationSec: ecouleSec === null || t.etat !== ETATS_TICKET.CONVOQUE ? null
        : Math.max(0, Math.round(r.delaiConvocationSec + r.delaiGraceSec - ecouleSec)),
      resteGarantieMin: g === null ? null : Math.round(g),
    };
  };

  const lignes = [];
  let i = 0;
  for (const t of ticketsConvoques(state).sort((a, b) => a.convoqueA - b.convoqueA)) {
    lignes.push(ligne(t, 'EN_ROUTE', ++i));
  }
  for (const t of ticketsEnAttente(state)) lignes.push(ligne(t, 'VIRTUELLE', ++i));
  return lignes;
}

/* ------------------------------------------------------------------------ */
/* Vue « metriques » pour le tableau de bord (F-15)                          */
/* ------------------------------------------------------------------------ */

export function vueMetriques(state) {
  const r = state.regles;
  const now = maintenant();
  const tickets = Object.values(state.tickets);
  // L'entree dans la salle n'est pas scannee : le passage mesure est le scan
  // a l'entree de la file reelle.
  const valides = tickets.filter((t) => t.valideA !== null);
  const expires = tickets.filter((t) => t.etat === ETATS_TICKET.EXPIRE);
  const annules = tickets.filter((t) => t.etat === ETATS_TICKET.ANNULE);
  const occupation = occupationSalle(state);

  // Attente reelle vecue par les visiteurs scannes, par statut : de
  // l'inscription au scan a l'entree de la file reelle.
  const reelsParStatut = {};
  for (const t of valides) {
    const reelMin = tempsActifEcoule(state, t.creeA, t.valideA) / 60_000;
    (reelsParStatut[t.statut] ??= []).push(reelMin);
  }

  const attentes = {};
  for (const code of Object.keys(r.statuts)) {
    const serie = reelsParStatut[code] ?? [];
    attentes[code] = {
      libelle: r.statuts[code].libelle,
      actuelMin: estimer(state, code, { occupationSalle: occupation }).minutes,
      moyenneMin: arrondi(moyenne(serie)),
      p90Min: arrondi(centile(serie, 90)),
      passages: serie.length,
    };
  }

  // Ecart entre attente annoncee a l'inscription et attente reellement vecue.
  const ecarts = valides
    .map((t) => {
      const reel = tempsActifEcoule(state, t.creeA, t.valideA) / 60_000;
      if (reel < 1) return null;
      return Math.abs(t.estimationInitialeMin - reel) / reel;
    })
    .filter((x) => x !== null);

  // RG-07 : la garantie Saiyan porte sur le delai jusqu'a la CONVOCATION.
  const saiyansConvoques = tickets.filter((t) => t.statut === 'SAIYAN' && t.convoqueA !== null);
  const garantieTenue = saiyansConvoques.filter(
    (t) => tempsActifEcoule(state, t.creeA, t.convoqueA) / 60_000 <= (r.statuts.SAIYAN.garantieMin ?? Infinity),
  ).length;

  // Remplissage de la salle depuis l'ouverture : entrees rapportees aux places
  // theoriquement offertes (capacite x rotations depuis le debut d'exploitation).
  const minutesExploitees = Math.max(1, minutesDuJour() - r.debutExploitation);
  const placesOffertes = Math.max(
    1, Math.round(r.capaciteSalle * ((minutesExploitees * 60) / dureeSejourMoyenneSec(r))),
  );

  const dureeIncidentsMin = state.incidents.reduce(
    (somme, i) => somme + ((i.fin ?? now) - i.debut) / 60_000, 0,
  );

  // Tickets qui ne seront pas servis avant la fermeture.
  const finJour = timestampDuJour(r.finExploitation);
  const devantReel = nombreDevantReel(state);
  const nonServis = ticketsEnAttente(state).filter((t) => {
    const est = estimer(state, t.statut, {
      rang: t.rang, occupationSalle: occupation, devantReel,
    });
    return now + est.minutes * 60_000 > finJour;
  }).length;

  return {
    remplissage: {
      attractionPct: arrondi((valides.length / placesOffertes) * 100),
      sallePct: arrondi((occupation / r.capaciteSalle) * 100),
      occupationSalle: occupation,
      capaciteSalle: r.capaciteSalle,
      fileReellePct: arrondi((occupationFileReelle(state) / r.capaciteFileReelle) * 100),
      occupationFileReelle: occupationFileReelle(state),
      capaciteFileReelle: r.capaciteFileReelle,
    },
    attentes,
    fileReelle: {
      presents: ticketsFileReelle(state).length,
      enRoute: ticketsConvoques(state).length,
      places: placesFileReelle(state),
    },
    garantieSaiyanPct: saiyansConvoques.length
      ? arrondi((garantieTenue / saiyansConvoques.length) * 100) : 100,
    ecartAnnonceReelPct: ecarts.length ? arrondi(moyenne(ecarts) * 100) : 0,
    absences: {
      tauxPct: valides.length + expires.length
        ? arrondi((expires.length / (valides.length + expires.length)) * 100) : 0,
      nombre: expires.length,
      refusScan: state.scans.filter((s) => s.verdict === 'REFUSE').length,
    },
    repartitionPassages: repartition(valides),
    incidents: { nombre: state.incidents.length, dureeCumuleeMin: arrondi(dureeIncidentsMin) },
    finDeJournee: {
      ticketsNonServis: nonServis,
      tauxDesistementPct: tickets.length ? arrondi((annules.length / tickets.length) * 100) : 0,
    },
    totaux: {
      inscrits: tickets.length,
      valides: valides.length,
      expires: expires.length,
      annules: annules.length,
      enAttente: ticketsEnAttente(state).length,
      enFileReelle: ticketsFileReelle(state).length,
      convoques: ticketsConvoques(state).length,
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

/* ------------------------------------------------------------------------ */
/* Vue « utilisateurs » pour l'administrateur                                */
/* ------------------------------------------------------------------------ */

/** Visiteurs de la journee, sans les comptes effaces (RGPD). */
export function vueUtilisateurs(state) {
  return Object.values(state.visiteurs)
    .filter((v) => !v.efface)
    .sort((a, b) => a.creeA - b.creeA)
    .map((v) => ({
      id: v.id,
      email: v.email,
      prenom: v.prenom,
      initiale: v.initiale,
      statut: v.statut,
      refBillet: v.refBillet,
      apte: v.apte,
    }));
}
