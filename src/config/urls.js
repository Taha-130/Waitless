/**
 * ---------------------------------------------------------------------------
 * URLS DES SERVICES EXTERNES
 * ---------------------------------------------------------------------------
 * Le seul endroit a modifier pour brancher le capteur ou la billetterie.
 *
 * Trois facons de changer une URL, de la plus durable a la plus ponctuelle :
 *   1. modifier la valeur ci-dessous ;
 *   2. la surcharger au lancement par variable d'environnement :
 *        WAITLESS_CAPTEUR_URL=http://... WAITLESS_BILLETTERIE_URL=http://... node server.js
 *   3. la changer a chaud dans le tableau de bord (onglet Regles). Ce reglage
 *      est trace dans le journal de la journee et ne vaut que pour celle-ci.
 *
 * Une URL vide desactive l'appel :
 *   - capteur     -> repli sur l'estimation interne de l'occupation ;
 *   - billetterie -> repli sur data/billetterie.json, puis sur un statut
 *                    deduit de l'e-mail (voir src/infra/billetterie.js).
 * ---------------------------------------------------------------------------
 */

export const URLS = {
  /** Capteur de la Salle du Temps. Repond `{"count": 42}` ou `42`. */
  capteur: process.env.WAITLESS_CAPTEUR_URL ?? '',

  /** Base de donnees de la billetterie : liste des visiteurs et de leur statut. */
  billetterie: process.env.WAITLESS_BILLETTERIE_URL ?? '',
};
