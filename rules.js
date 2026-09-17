/**
 * ---------------------------------------------------------------------------
 * REGLES METIER PARAMETRABLES
 * ---------------------------------------------------------------------------
 * Couvre RG-15 et F-16 : « tous les seuils sont modifiables depuis le tableau
 * de bord, sans redeploiement ».
 *
 * Ce fichier ne contient QUE des valeurs par defaut et leurs bornes de
 * validite. Les valeurs reellement utilisees a l'execution vivent dans l'etat
 * du systeme (voir src/domain/state.js) et sont modifiees par l'evenement
 * REGLES_MODIFIEES. Redemarrer le serveur rejoue cet evenement : la
 * configuration survit donc a un arret.
 * ---------------------------------------------------------------------------
 */

/** Codes des trois statuts de priorite. Le rang 1 est le plus prioritaire. */
export const STATUTS = ['SUPER_SAIYAN', 'SAIYAN', 'HUMAIN'];

export const REGLES_PAR_DEFAUT = {
  // --- Horaires (en minutes depuis minuit) ------------------------------
  ouvertureFile: 8 * 60,        // RG-01 : la file virtuelle ouvre avec le parc
  debutExploitation: 9 * 60,    // RG-01 : premiere convocation possible
  finExploitation: 19 * 60,     // RG-01 : plus aucune convocation apres

  // --- Capacite de l'attraction -----------------------------------------
  dureeCycleMin: 20,            // un cycle de la Salle du Temps
  placesParCycle: 20,           // 20 visiteurs par cycle => 60/heure
  capaciteSalleAttente: 50,     // F-14 : la salle physique ne depasse pas 50

  // --- Convocation (RG-09) ----------------------------------------------
  delaiConvocationSec: 600,     // 10 minutes pour se presenter
  delaiGraceSec: 45,            // tolerance paramétrable de 30 a 60 s
  rappelAvantFinSec: 120,       // rappel 2 minutes avant l'expiration

  // --- Fermeture des inscriptions (RG-04 / RG-05) -----------------------
  margeSecuriteMin: 10,         // marge retranchee a l'heure de fermeture
  seuilVigilanceMin: 15,        // sous ce reliquat, on avertit les derniers

  // --- Estimation de l'attente ------------------------------------------
  facteurFourchetteBasse: 0.85, // borne basse de la fourchette affichee
  facteurFourchetteHaute: 1.25, // borne haute
  elargissementIncident: 1.6,   // la fourchette s'elargit apres un incident
  attenteMaxAffichableMin: 300, // garde-fou : on n'annonce jamais plus

  // --- Statuts de priorite (referentiel configurable) -------------------
  // quotaCycle : part MAXIMALE des places d'un cycle (RG-06, RG-07)
  // partMin    : part MINIMALE reservee, evite la famine (RG-08)
  // garantieMin: attente garantie en minutes, null = pas de garantie
  statuts: {
    SUPER_SAIYAN: { libelle: 'Super Saiyan', rang: 1, quotaCycle: 0.15, partMin: 0, garantieMin: 0 },
    SAIYAN: { libelle: 'Saiyan', rang: 2, quotaCycle: 0.35, partMin: 0, garantieMin: 30 },
    HUMAIN: { libelle: 'Humain', rang: 3, quotaCycle: 1.0, partMin: 0.5, garantieMin: null },
  },

  // --- Exploitation technique -------------------------------------------
  periodeTickMs: 5000,          // F-05 : mise a jour en moins de 5 secondes
  validiteJetonQrSec: 30,       // F-10 : le QR tourne toutes les 30 secondes
  codeAgent: 'AGENT-2026',      // acces console agent
  codeAdmin: 'ADMIN-2026',      // acces tableau de bord
  capteurUrl: '',               // URL du capteur de salle (vide = repli interne)
};

/**
 * Bornes de validite. Toute modification hors bornes est refusee : un
 * parametre mal saisi ne doit pas pouvoir casser l'exploitation.
 */
export const BORNES = {
  ouvertureFile: [0, 1439],
  debutExploitation: [0, 1439],
  finExploitation: [0, 1439],
  dureeCycleMin: [1, 120],
  placesParCycle: [1, 200],
  capaciteSalleAttente: [1, 500],
  delaiConvocationSec: [60, 3600],
  delaiGraceSec: [30, 60],
  rappelAvantFinSec: [0, 1800],
  margeSecuriteMin: [0, 120],
  seuilVigilanceMin: [0, 240],
  facteurFourchetteBasse: [0.5, 1],
  facteurFourchetteHaute: [1, 2],
  elargissementIncident: [1, 3],
  attenteMaxAffichableMin: [30, 1440],
  periodeTickMs: [1000, 60000],
  validiteJetonQrSec: [10, 300],
};

/**
 * Valide un ensemble de modifications de regles.
 * @returns {{ok: boolean, erreurs: string[], valeurs: object}}
 */
export function validerRegles(patch) {
  const erreurs = [];
  const valeurs = {};

  for (const [cle, valeur] of Object.entries(patch)) {
    // Cas particulier : le referentiel des statuts.
    if (cle === 'statuts') {
      const statuts = {};
      for (const code of STATUTS) {
        const s = valeur?.[code];
        if (!s) continue;
        statuts[code] = {
          ...REGLES_PAR_DEFAUT.statuts[code],
          ...s,
          quotaCycle: borner(s.quotaCycle, 0, 1, REGLES_PAR_DEFAUT.statuts[code].quotaCycle),
          partMin: borner(s.partMin, 0, 1, REGLES_PAR_DEFAUT.statuts[code].partMin),
        };
      }
      valeurs.statuts = statuts;
      continue;
    }

    // Chaines libres : pas de bornes numeriques.
    if (['codeAgent', 'codeAdmin', 'capteurUrl'].includes(cle)) {
      valeurs[cle] = String(valeur ?? '');
      continue;
    }

    const borne = BORNES[cle];
    if (!borne) {
      erreurs.push(`Paramètre inconnu : ${cle}`);
      continue;
    }
    const nombre = Number(valeur);
    if (Number.isNaN(nombre)) {
      erreurs.push(`${cle} doit être un nombre`);
      continue;
    }
    if (nombre < borne[0] || nombre > borne[1]) {
      erreurs.push(`${cle} doit être compris entre ${borne[0]} et ${borne[1]}`);
      continue;
    }
    valeurs[cle] = nombre;
  }

  return { ok: erreurs.length === 0, erreurs, valeurs };
}

function borner(v, min, max, defaut) {
  const n = Number(v);
  if (Number.isNaN(n)) return defaut;
  return Math.min(max, Math.max(min, n));
}
