/**
 * ---------------------------------------------------------------------------
 * NOTIFICATIONS E-MAIL (simulees)
 * ---------------------------------------------------------------------------
 * Aucun SMTP : les messages sont affiches dans la console ET conserves dans une
 * boite aux lettres en memoire, consultable dans l'application. Cela rend la
 * demonstration lisible (le jury voit partir la convocation) et supprime le
 * risque de delivrabilite identifie au chapitre 8.
 *
 * Pour brancher un vrai service transactionnel plus tard, il suffit de
 * remplacer le corps de `envoyer()` : aucun autre fichier ne change.
 * ---------------------------------------------------------------------------
 */

import { maintenant, formatHeure } from '../domain/clock.js';

const MAX_MESSAGES = 200;
const boite = [];   // du plus recent au plus ancien

/**
 * « Envoie » un message.
 * @param {string} destinataire e-mail
 * @param {string} sujet
 * @param {string} corps
 * @param {string} type       LIEN | CONVOCATION | RAPPEL | VIGILANCE | INCIDENT | EXPIRATION
 */
export function envoyer(destinataire, sujet, corps, type = 'INFO') {
  const message = { id: boite.length + 1, destinataire, sujet, corps, type, ts: maintenant() };
  boite.unshift(message);
  if (boite.length > MAX_MESSAGES) boite.pop();
  if (!process.env.WAITLESS_SILENCIEUX) {
    console.log(`[mail ${formatHeure(message.ts)}] -> ${destinataire} | ${sujet}`);
  }
  return message;
}

/** Boite aux lettres complete, ou filtree sur un destinataire. */
export function messages(destinataire = null) {
  return destinataire
    ? boite.filter((m) => m.destinataire === destinataire)
    : boite;
}

export function viderBoite() {
  boite.length = 0;
}
