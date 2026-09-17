/**
 * ---------------------------------------------------------------------------
 * JOURNAL D'EVENEMENTS
 * ---------------------------------------------------------------------------
 * Un seul fichier texte par journee d'exploitation : data/evenements-AAAA-MM-JJ.jsonl
 * Une ligne = un evenement JSON, ajoute en fin de fichier, jamais modifie.
 *
 * C'est la « source de verite » annoncee au chapitre 6 du cahier des charges.
 * On ne stocke pas l'etat, on stocke l'histoire ; l'etat est recalcule.
 *
 * Pourquoi pas une base de donnees ? Parce que l'exigence reelle (RG-13) est la
 * durabilite de l'ordre et la reprise apres panne, pas la richesse des
 * requetes. Un journal append-only y repond avec zero dependance et zero
 * installation. Le passage a PostgreSQL ne changerait que ce fichier : le reste
 * du domaine ne connait que `publier()` et `etat()`.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { maintenant, jourExploitation } from './clock.js';
import { etatInitial, appliquer } from './state.js';

const DOSSIER = 'data';

let state = etatInitial();
let jourCourant = null;
let fichierCourant = null;
const abonnes = new Set();    // callbacks notifies apres chaque evenement

/** Chemin du journal d'une journee. */
function fichierDuJour(jour) {
  return path.join(DOSSIER, `evenements-${jour}.jsonl`);
}

/**
 * Charge (ou recharge) la journee courante depuis le disque.
 * Appelee au demarrage, puis a chaque changement de jour.
 */
export function chargerJournee(jour = jourExploitation()) {
  fs.mkdirSync(DOSSIER, { recursive: true });

  state = etatInitial();
  state.jour = jour;
  jourCourant = jour;

  const fichier = fichierDuJour(jour);
  if (fs.existsSync(fichier)) {
    const lignes = fs.readFileSync(fichier, 'utf8').split('\n');
    let rejoues = 0;
    for (const ligne of lignes) {
      if (!ligne.trim()) continue;
      try {
        appliquer(state, JSON.parse(ligne));
        rejoues++;
      } catch {
        // Ligne corrompue (arret brutal en pleine ecriture) : on l'ignore et on
        // continue. Le journal reste exploitable, c'est l'interet du format.
      }
    }
    if (rejoues) console.log(`[journal] ${rejoues} evenement(s) rejoue(s) pour le ${jour}`);
  }

  fichierCourant = fichier;
  return state;
}

/** Bascule automatique quand la journee d'exploitation change. */
export function verifierJour() {
  const jour = jourExploitation();
  if (jour !== jourCourant) chargerJournee(jour);
}

/** Etat courant, reconstruit depuis le journal. Lecture seule par convention. */
export function etat() {
  return state;
}

/**
 * Ajoute un evenement au journal puis l'applique.
 * @param {string} type   type d'evenement (voir state.js)
 * @param {object} donnees charge utile, doit suffire a rejouer l'evenement
 */
export function publier(type, donnees = {}) {
  const ev = {
    seq: state.dernierSeq + 1,
    type,
    ts: donnees.ts ?? maintenant(),
    jour: jourCourant,
    ...donnees,
  };

  // Ecriture AVANT application, et de facon SYNCHRONE : si le processus meurt
  // juste apres, l'evenement est deja sur le disque. Un flux tamponne aurait
  // pu perdre les dernieres lignes, ce qui viderait RG-13 de son sens.
  fs.appendFileSync(fichierCourant, JSON.stringify(ev) + '\n');
  appliquer(state, ev);

  for (const cb of abonnes) {
    try { cb(ev, state); } catch (e) { console.error('[journal] abonne en erreur', e); }
  }
  return ev;
}

/** S'abonner aux evenements (utilise par le flux temps reel SSE). */
export function surEvenement(cb) {
  abonnes.add(cb);
  return () => abonnes.delete(cb);
}

/** Identifiant court et lisible, prefixe par domaine. */
export function nouvelId(prefixe) {
  return `${prefixe}_${randomUUID().slice(0, 8)}`;
}

/** Efface la journee courante (utilise par `npm run reset`). */
export function effacerJournee(jour = jourExploitation()) {
  const fichier = fichierDuJour(jour);
  if (fs.existsSync(fichier)) fs.unlinkSync(fichier);
  return chargerJournee(jour);
}
