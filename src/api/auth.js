/**
 * ---------------------------------------------------------------------------
 * AUTHENTIFICATION
 * ---------------------------------------------------------------------------
 * Chapitre 7 : « connexion par lien e-mail a usage unique : aucun mot de passe,
 * donc aucune donnee d'authentification a proteger ».
 *
 * Deux jetons, tous deux signes et SANS stockage serveur :
 *   - lien magique : porte l'e-mail + une expiration courte ;
 *   - session      : porte le role et l'identifiant.
 *
 * Etre sans etat a un avantage concret ici : un redemarrage du serveur ne
 * deconnecte personne, ce qui est indispensable pour demontrer la reprise
 * apres panne sans que le jury doive se reconnecter (RG-13).
 * ---------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { maintenant } from '../domain/clock.js';
import { etat } from '../domain/eventStore.js';
import { erreurHttp } from './http.js';

const SECRET = process.env.WAITLESS_SECRET || 'salle-du-temps-secret-de-demo';
const DUREE_LIEN_MS = 15 * 60_000;

function signer(charge) {
  return createHmac('sha256', SECRET).update(charge).digest('base64url').slice(0, 24);
}

function comparer(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/* --- Lien magique -------------------------------------------------------- */

export function creerLienMagique(email) {
  const expire = maintenant() + DUREE_LIEN_MS;
  const charge = `${Buffer.from(email).toString('base64url')}.${expire}`;
  return `${charge}.${signer(charge)}`;
}

export function verifierLienMagique(jeton) {
  const parts = String(jeton || '').split('.');
  if (parts.length !== 3) return null;
  const [emailB64, expire, sig] = parts;
  if (!comparer(signer(`${emailB64}.${expire}`), sig)) return null;
  if (Number(expire) < maintenant()) return null;
  return Buffer.from(emailB64, 'base64url').toString('utf8');
}

/* --- Session ------------------------------------------------------------- */

export function creerSession(role, id) {
  const charge = `${role}.${id}`;
  return `${charge}.${signer(charge)}`;
}

export function verifierSession(jeton) {
  const parts = String(jeton || '').split('.');
  if (parts.length !== 3) return null;
  const [role, id, sig] = parts;
  if (!comparer(signer(`${role}.${id}`), sig)) return null;
  return { role, id };
}

/* --- Extraction depuis la requete --------------------------------------- */

/** Lit le jeton dans l'en-tete Authorization ou, pour SSE, le parametre `t`. */
export function sessionDe(ctx) {
  const entete = ctx.req.headers.authorization || '';
  const jeton = entete.startsWith('Bearer ') ? entete.slice(7) : ctx.query.get('t');
  return verifierSession(jeton);
}

/** Exige un role parmi ceux autorises, sinon 401/403. */
export function exigerRole(ctx, ...roles) {
  const session = sessionDe(ctx);
  if (!session) throw erreurHttp(401, 'Authentification requise');
  if (!roles.includes(session.role)) throw erreurHttp(403, 'Accès refusé pour ce rôle');
  return session;
}

/** Exige un visiteur connu et existant dans l'etat courant. */
export function exigerVisiteur(ctx) {
  const session = exigerRole(ctx, 'visiteur');
  const v = etat().visiteurs[session.id];
  if (!v) throw erreurHttp(401, 'Session expirée — reconnectez-vous');
  return v;
}
