/**
 * ---------------------------------------------------------------------------
 * CAPTEUR DE LA SALLE D'ATTENTE (F-14)
 * ---------------------------------------------------------------------------
 * Le capteur n'est pas realise par Waitless : il expose une URL qui renvoie le
 * nombre de personnes presentes et leurs identifiants techniques.
 *
 * Ce module se contente donc de :
 *   - interroger l'URL configuree (regle `capteurUrl`) a chaque tick ;
 *   - conserver le dernier releve et sa fraicheur ;
 *   - retomber sur un comptage interne si l'URL est absente ou injoignable,
 *     pour que l'exploitation ne s'arrete jamais faute de capteur.
 *
 * Format attendu, tolerant :
 *   { "count": 12, "ids": ["tag-1", "tag-2", ...] }
 *   ou simplement un nombre.
 *
 * Interet metier : distinguer une veritable absence d'un simple defaut de scan,
 * et ne jamais convoquer au-dela des 50 places de la salle.
 * ---------------------------------------------------------------------------
 */

import { maintenant } from '../domain/clock.js';

let dernier = { occupation: 0, ids: [], source: 'interne', ts: 0, erreur: null };
let forcage = null;   // valeur imposee manuellement depuis le tableau de bord

/**
 * Interroge le capteur. Ne leve jamais : un capteur en panne ne doit pas
 * interrompre l'ordonnanceur.
 * @param {string} url            URL du capteur (peut etre vide)
 * @param {number} repliInterne   nombre de convoques non encore entres
 */
export async function releverCapteur(url, repliInterne) {
  if (forcage !== null) {
    dernier = { occupation: forcage, ids: [], source: 'force', ts: maintenant(), erreur: null };
    return dernier;
  }

  if (!url) {
    dernier = { occupation: repliInterne, ids: [], source: 'interne', ts: maintenant(), erreur: null };
    return dernier;
  }

  try {
    const reponse = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const donnees = await reponse.json();
    const occupation = typeof donnees === 'number'
      ? donnees
      : Number(donnees.count ?? donnees.occupation ?? donnees.nombre ?? 0);
    const ids = Array.isArray(donnees?.ids) ? donnees.ids : [];
    dernier = { occupation, ids, source: 'capteur', ts: maintenant(), erreur: null };
  } catch (e) {
    // Repli : on ne bloque pas la file, on signale la degradation.
    dernier = {
      occupation: repliInterne, ids: [], source: 'interne',
      ts: maintenant(), erreur: String(e.message || e),
    };
  }
  return dernier;
}

/** Dernier releve connu. */
export function dernierReleve() {
  return dernier;
}

/** Force (ou libere, avec null) l'occupation, pour la demonstration. */
export function forcerOccupation(valeur) {
  forcage = valeur === null || valeur === undefined || valeur === '' ? null : Number(valeur);
  return forcage;
}
