/**
 * ---------------------------------------------------------------------------
 * JETON QR ROTATIF  (F-10, chapitre 7)
 * ---------------------------------------------------------------------------
 * Contrainte : « QR code nominatif rotatif, a usage unique et journalier ; une
 * capture d'ecran est refusee apres expiration ».
 *
 * Solution : un jeton signe, sans stockage.
 *
 *   creneau = floor(heure / 30 s)
 *   cleDuJour = HMAC(SECRET, jour d'exploitation)
 *   jeton = ticketId . creneau . HMAC(cleDuJour, "ticketId.creneau")
 *
 * - Rotatif      : le creneau change toutes les 30 s, l'ancien jeton ne valide plus.
 * - Journalier   : la cle derive de la date, donc tout jeton est mort le lendemain.
 * - Sans base    : la verification est un simple calcul, rien a stocker.
 * - Usage unique : garanti par l'etat du ticket (une fois ENTRE, il est refuse).
 * - Revocable    : un desistement ou un retrait change l'etat, donc refuse aussitot.
 *
 * Le jeton ne vaut pas identite : l'agent controle la piece d'identite (ch. 7).
 * ---------------------------------------------------------------------------
 */

import { createHmac } from 'node:crypto';
import { maintenant, jourExploitation } from './clock.js';

// En production ce secret viendrait d'une variable d'environnement.
const SECRET = process.env.WAITLESS_SECRET || 'salle-du-temps-secret-de-demo';

function cleDuJour(jour) {
  return createHmac('sha256', SECRET).update(`jour:${jour}`).digest();
}

function signer(ticketId, creneau, jour) {
  return createHmac('sha256', cleDuJour(jour))
    .update(`${ticketId}.${creneau}`)
    .digest('hex')
    .slice(0, 12);
}

/** Numero du creneau de 30 secondes courant. */
function creneauCourant(validiteSec) {
  return Math.floor(maintenant() / (validiteSec * 1000));
}

/**
 * Genere le jeton courant d'un ticket.
 * @returns {{jeton:string, expireDans:number}} expireDans en secondes
 */
export function genererJeton(ticketId, validiteSec = 30) {
  const jour = jourExploitation();
  const creneau = creneauCourant(validiteSec);
  const jeton = `${ticketId}.${creneau}.${signer(ticketId, creneau, jour)}`;
  const expireDans = Math.ceil(((creneau + 1) * validiteSec * 1000 - maintenant()) / 1000);
  return { jeton, expireDans, validiteSec };
}

/**
 * Verifie un jeton presente par l'agent.
 * On accepte le creneau courant ET le precedent : le visiteur peut avoir
 * affiche son code juste avant une rotation, sans quoi le scan echouerait
 * injustement une fois sur deux.
 *
 * @returns {{valide:boolean, ticketId?:string, motif?:string}}
 */
export function verifierJeton(jetonBrut, validiteSec = 30) {
  const jeton = String(jetonBrut || '').trim();
  const morceaux = jeton.split('.');
  if (morceaux.length !== 3) return { valide: false, motif: 'Code illisible' };

  const [ticketId, creneauTexte, signature] = morceaux;
  const creneau = Number(creneauTexte);
  if (!Number.isInteger(creneau)) return { valide: false, motif: 'Code illisible' };

  const jour = jourExploitation();
  const actuel = creneauCourant(validiteSec);

  if (creneau !== actuel && creneau !== actuel - 1) {
    // Capture d'ecran partagee, ou code de la veille.
    return { valide: false, motif: 'Code expiré — demandez au visiteur de rafraîchir' };
  }
  if (signer(ticketId, creneau, jour) !== signature) {
    return { valide: false, motif: 'Signature invalide' };
  }
  return { valide: true, ticketId };
}
