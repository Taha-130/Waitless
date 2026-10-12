/**
 * ---------------------------------------------------------------------------
 * REGLES D'EXPLOITATION
 * ---------------------------------------------------------------------------
 * Toutes les valeurs chiffrees du metier sont ici, et NULLE PART ailleurs :
 * aucun nombre magique dans le domaine. C'est ce qui rend RG-15 / F-16
 * realisable (« modifier les seuils sans redeploiement ») : l'ecran
 * d'administration ecrit dans cet objet a travers un evenement
 * REGLES_MODIFIEES, et le domaine lit `state.regles` a chaque decision.
 *
 * ---------------------------------------------------------------------------
 * LE MODELE D'ATTENTE, EN TROIS ETAGES
 * ---------------------------------------------------------------------------
 *
 *   1. FILE VIRTUELLE   nombre illimite. On y prend son rang depuis son
 *                       telephone, puis on profite du parc.
 *
 *   2. FILE REELLE      `capaciteFileReelle` personnes au maximum (30), juste
 *                       devant l'attraction. On y est CONVOQUE, on s'y rend,
 *                       et l'agent scanne le QR code a l'entree de la file.
 *                       C'est le seul scan du parcours.
 *
 *   3. SALLE DU TEMPS   `capaciteSalle` personnes au maximum (50). Un second
 *                       agent, sans application, y fait entrer la file reelle
 *                       au rythme des places qui se liberent, sans nouvelle
 *                       verification. On en sort quand on veut : c'est le
 *                       CAPTEUR, et lui seul, qui dit combien de personnes
 *                       s'y trouvent.
 *
 * Consequence directe sur le parametrage : il n'y a ni cycle, ni fournee. Le
 * debit n'est pas decrete, il se deduit de la capacite de la salle et de la
 * duree de sejour (30 s a 2 min, soit 75 s en moyenne), puis se recale sur les
 * entrees reellement observees.
 * ---------------------------------------------------------------------------
 */

import { URLS } from './urls.js';

export const REGLES_PAR_DEFAUT = {
  /* --- Capacites ------------------------------------------------------- */

  /** Capacite de la Salle du Temps. C'est ce que compte le capteur. */
  capaciteSalle: 50,

  /** Capacite de la file d'attente physique, juste devant l'attraction. */
  capaciteFileReelle: 30,

  /**
   * Duree de presence dans la salle, en SECONDES : entre 30 s et 2 min. Les
   * visiteurs sortent quand ils veulent : ces valeurs ne sont donc pas une
   * regle imposee mais une hypothese de debit (moyenne = milieu de la plage,
   * 75 s), que l'estimateur corrige avec les entrees observees.
   */
  dureeSejourMinSec: 30,
  dureeSejourMaxSec: 120,

  /* --- Delais de convocation (RG-09, RG-10) ---------------------------- */

  /** Temps laisse au visiteur pour REJOINDRE LA FILE REELLE apres l'appel. */
  delaiConvocationSec: 600,       // 10 min
  /** Tolerance supplementaire avant expiration. */
  delaiGraceSec: 120,             // 2 min
  /** Rappel envoye tant de secondes avant la fin du delai. */
  rappelAvantFinSec: 120,
  /** Duree de validite d'un jeton QR (rotation). */
  validiteJetonQrSec: 30,

  /* --- Horaires, en minutes depuis minuit (RG-01) ----------------------- */

  ouvertureFile: 8 * 60,          // 08h00 : ouverture des inscriptions
  debutExploitation: 9 * 60,      // 09h00 : premieres convocations
  finExploitation: 19 * 60,       // 19h00 : derniere entree

  /** RG-04 : fermeture des inscriptions = fin - attente estimee - cette marge. */
  margeSecuriteMin: 15,
  /** RG-05 : en deca de ce reste, on avertit les visiteurs menaces. */
  seuilVigilanceMin: 30,

  /* --- Priorites (RG-06, RG-07, RG-08) --------------------------------- */

  /**
   * Les quotas ne peuvent plus s'exprimer « par cycle » : il n'y a plus de
   * cycle. Ils s'appliquent donc a une FENETRE GLISSANTE des dernieres
   * convocations. Dire « 15 % maximum » signifie desormais : sur les
   * `fenetreQuotaConvocations` dernieres convocations, pas plus de 15 % de
   * Super Saiyans. La contrainte est equivalente, et elle est continue.
   */
  fenetreQuotaConvocations: 50,

  /** Marge, en minutes, en deca de laquelle une garantie devient urgente. */
  horizonUrgenceMin: 5,

  statuts: {
    SUPER_SAIYAN: {
      libelle: 'Super Saiyan',
      rang: 0,                    // passe devant tout le monde
      garantieMin: 0,             // acces immediat
      quotaFenetre: 0.15,         // RG-06 : 15 % des convocations au maximum
      partMin: 0,
    },
    SAIYAN: {
      libelle: 'Saiyan',
      rang: 1,
      garantieMin: 30,            // RG-07 : 30 min garanties jusqu'a la convocation
      quotaFenetre: 0.35,
      partMin: 0,
    },
    HUMAIN: {
      libelle: 'Humain',
      rang: 2,
      garantieMin: null,          // ordre d'arrivee, sans promesse de delai
      quotaFenetre: 1,
      partMin: 0.5,               // RG-08 : la moitie des convocations leur revient
    },
  },

  /* --- Estimation ------------------------------------------------------- */

  facteurFourchetteBasse: 0.8,
  facteurFourchetteHaute: 1.2,
  elargissementIncident: 1.5,     // fourchette elargie apres un incident
  attenteMaxAffichableMin: 240,   // on n'annonce jamais plus de 4 h

  /* --- Exploitation technique ------------------------------------------ */

  periodeTickMs: 5000,            // battement de l'ordonnanceur
  capteurUrl: URLS.capteur,       // vide = repli sur l'estimation interne (src/config/urls.js)
  billetterieUrl: URLS.billetterie, // vide = repli sur data/billetterie.json (src/config/urls.js)
  codeAgent: 'AGENT-2026',
  codeAdmin: 'ADMIN-2026',
};

/** Duree moyenne de sejour, en secondes : le milieu de la plage min-max. */
export function dureeSejourMoyenneSec(regles) {
  return (regles.dureeSejourMinSec + regles.dureeSejourMaxSec) / 2;
}

/**
 * Bornes de validite. Toute valeur modifiable a chaud est bornee ici : une
 * saisie hors bornes est refusee avec un message explicite plutot que
 * d'entrainer l'exploitation dans un etat absurde (RG-15).
 */
const BORNES = {
  capaciteSalle: [1, 500, 'Capacité de la Salle du Temps'],
  capaciteFileReelle: [1, 200, 'Capacité de la file réelle'],
  dureeSejourMinSec: [5, 14400, 'Durée minimale de séjour (s)'],
  dureeSejourMaxSec: [5, 14400, 'Durée maximale de séjour (s)'],
  delaiConvocationSec: [60, 3600, 'Délai de convocation (s)'],
  delaiGraceSec: [0, 1800, 'Délai de grâce (s)'],
  rappelAvantFinSec: [0, 1800, 'Rappel avant expiration (s)'],
  validiteJetonQrSec: [10, 300, 'Validité du jeton QR (s)'],
  ouvertureFile: [0, 1439, 'Ouverture des inscriptions'],
  debutExploitation: [0, 1439, "Début d'exploitation"],
  finExploitation: [1, 1440, "Fin d'exploitation"],
  margeSecuriteMin: [0, 120, 'Marge de sécurité (min)'],
  seuilVigilanceMin: [0, 240, 'Seuil de vigilance (min)'],
  fenetreQuotaConvocations: [5, 500, 'Fenêtre des quotas (convocations)'],
  horizonUrgenceMin: [0, 60, "Horizon d'urgence (min)"],
  facteurFourchetteBasse: [0.1, 1, 'Facteur bas de la fourchette'],
  facteurFourchetteHaute: [1, 3, 'Facteur haut de la fourchette'],
  elargissementIncident: [1, 5, 'Élargissement après incident'],
  attenteMaxAffichableMin: [10, 1440, 'Attente maximale affichable (min)'],
  periodeTickMs: [500, 60000, "Période de l'ordonnanceur (ms)"],
};

/** Champs texte acceptes tels quels (pas de borne numerique). */
const TEXTES = ['capteurUrl', 'billetterieUrl', 'codeAgent', 'codeAdmin'];

/**
 * Valide un lot de modifications de regles.
 *
 * Les valeurs arrivent du formulaire d'administration, donc sous forme de
 * chaines : on les convertit ici, une bonne fois, pour que le domaine ne
 * manipule que des nombres.
 *
 * @param {object} patch
 * @returns {{ok:boolean, erreurs:string[], valeurs:object}}
 */
export function validerRegles(patch = {}) {
  const erreurs = [];
  const valeurs = {};

  for (const [cle, brut] of Object.entries(patch)) {
    if (cle === 'statuts') continue;                 // traite plus bas
    if (TEXTES.includes(cle)) { valeurs[cle] = String(brut ?? ''); continue; }

    const borne = BORNES[cle];
    if (!borne) continue;                            // cle inconnue : ignoree

    const [min, max, libelle] = borne;
    const n = Number(brut);
    if (!Number.isFinite(n)) {
      erreurs.push(`${libelle} : valeur non numérique`);
      continue;
    }
    if (n < min || n > max) {
      erreurs.push(`${libelle} : ${n} hors bornes (${min} à ${max})`);
      continue;
    }
    valeurs[cle] = n;
  }

  // Coherence des horaires : l'ordre doit rester ouverture < debut < fin.
  const fusion = { ...REGLES_PAR_DEFAUT, ...valeurs };
  if (fusion.ouvertureFile > fusion.debutExploitation) {
    erreurs.push("Les inscriptions ne peuvent pas ouvrir après le début d'exploitation");
  }
  if (fusion.debutExploitation >= fusion.finExploitation) {
    erreurs.push("La fin d'exploitation doit suivre le début d'exploitation");
  }
  if (fusion.dureeSejourMinSec > fusion.dureeSejourMaxSec) {
    erreurs.push('La durée minimale de séjour dépasse la durée maximale');
  }
  if (fusion.facteurFourchetteBasse > fusion.facteurFourchetteHaute) {
    erreurs.push('La borne basse de la fourchette dépasse la borne haute');
  }
  // La file reelle n'a aucun sens si elle est plus grande que la salle : elle
  // ne se viderait jamais assez vite pour que l'attente annoncee tienne.
  if (fusion.capaciteFileReelle > fusion.capaciteSalle) {
    erreurs.push('La file réelle ne peut pas dépasser la capacité de la salle');
  }

  // Quotas et parts minimales par statut.
  if (patch.statuts) {
    const statuts = {};
    for (const [code, cfg] of Object.entries(patch.statuts)) {
      if (!REGLES_PAR_DEFAUT.statuts[code]) {
        erreurs.push(`Statut inconnu : ${code}`);
        continue;
      }
      const sortie = {};
      for (const champ of ['quotaFenetre', 'partMin']) {
        if (cfg[champ] === undefined) continue;
        const n = Number(cfg[champ]);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          erreurs.push(`${code} · ${champ} : doit être une part entre 0 et 1`);
          continue;
        }
        sortie[champ] = n;
      }
      if (cfg.garantieMin !== undefined) {
        const n = cfg.garantieMin === null || cfg.garantieMin === '' ? null : Number(cfg.garantieMin);
        if (n !== null && (!Number.isFinite(n) || n < 0 || n > 480)) {
          erreurs.push(`${code} · garantie : doit être vide ou comprise entre 0 et 480 min`);
        } else {
          sortie.garantieMin = n;
        }
      }
      if (Object.keys(sortie).length) statuts[code] = sortie;
    }

    // La somme des parts reservees ne doit pas depasser la totalite des places.
    const sommeParts = Object.entries(REGLES_PAR_DEFAUT.statuts).reduce((somme, [code, cfg]) => {
      const part = statuts[code]?.partMin ?? cfg.partMin ?? 0;
      return somme + part;
    }, 0);
    if (sommeParts > 1) {
      erreurs.push(`Les parts réservées totalisent ${Math.round(sommeParts * 100)} % : au-delà de 100 %, aucune convocation n'est possible`);
    }

    if (Object.keys(statuts).length) valeurs.statuts = statuts;
  }

  return { ok: erreurs.length === 0, erreurs, valeurs };
}