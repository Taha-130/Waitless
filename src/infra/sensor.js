/**
 * ---------------------------------------------------------------------------
 * CAPTEUR DE LA SALLE DU TEMPS (F-14)
 * ---------------------------------------------------------------------------
 * Ce que compte le capteur, et c'est tout ce qu'il compte : le nombre de
 * personnes PRESENTES DANS LA SALLE DU TEMPS. Pas la file virtuelle, qui est
 * illimitee et connue du systeme ; pas la file reelle, dont le systeme connait
 * exactement la composition puisqu'il l'a convoquee lui-meme.
 *
 * Pourquoi un capteur pour cette seule mesure : les visiteurs sortent de la
 * salle quand ils veulent, sans rien scanner. Aucun evenement ne signale leur
 * depart. Le systeme sait qui entre, il ne peut pas savoir qui sort. Le capteur
 * est donc la seule source de verite sur le remplissage — et c'est lui qui
 * permet a l'agent de savoir combien de personnes il peut encore faire entrer.
 *
 * Le capteur n'est pas realise par Waitless : il expose une URL. Ce module se
 * contente de :
 *   - interroger l'URL configuree (regle `capteurUrl`) a chaque tick ;
 *   - conserver le dernier releve et sa fraicheur ;
 *   - retomber sur l'estimation interne si l'URL est absente ou injoignable,
 *     pour que l'exploitation ne s'arrete jamais faute de capteur.
 *
 * Format attendu, tolerant :
 *   { "count": 42, "ids": ["tag-1", "tag-2", ...] }
 *   ou simplement un nombre.
 * ---------------------------------------------------------------------------
 */

import { maintenant } from '../domain/clock.js';

let dernier = { occupation: 0, ids: [], source: 'interne', ts: 0, erreur: null };
let forcage = null;   // valeur imposee manuellement depuis le tableau de bord

/**
 * Interroge le capteur. Ne leve jamais : un capteur en panne ne doit pas
 * interrompre l'ordonnanceur.
 *
 * @param {string} url          URL du capteur (peut etre vide)
 * @param {number} repliInterne occupation estimee de la salle, calculee par le
 *                              domaine a partir des entrees scannees et de la
 *                              duree moyenne de sejour
 */
export async function releverCapteur(url, repliInterne = 0) {
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
    // Repli : on ne bloque pas l'attraction, on signale la degradation. L'agent
    // voit dans sa console que le comptage n'est plus celui du capteur, et peut
    // decider de compter lui-meme.
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

/**
 * Force (ou libere, avec null) l'occupation, pour la demonstration.
 *
 * Le relevé est mis a jour immediatement, sans attendre le battement suivant :
 * sinon, forcer la salle a 50 devant un jury laisserait passer les cinq
 * secondes suivantes, et la demonstration montrerait exactement l'inverse de
 * ce qu'elle veut prouver.
 */
export function forcerOccupation(valeur) {
  forcage = valeur === null || valeur === undefined || valeur === '' ? null : Number(valeur);
  if (forcage !== null) {
    dernier = { occupation: forcage, ids: [], source: 'force', ts: maintenant(), erreur: null };
  }
  return forcage;
}

/** Remet le capteur a zero. Utilise par les tests et par la purge de journee. */
export function reinitialiserCapteur() {
  dernier = { occupation: 0, ids: [], source: 'interne', ts: 0, erreur: null };
  forcage = null;
}
