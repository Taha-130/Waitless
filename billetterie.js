/**
 * ---------------------------------------------------------------------------
 * REFERENTIEL BILLETTERIE (simule)
 * ---------------------------------------------------------------------------
 * Hypothese du cahier des charges : « Statuts attribues a la billetterie et
 * importes dans Waitless ; l'application ne vend pas de statut ».
 *
 * Waitless ne cree donc jamais un statut : il le LIT. Ici, la lecture se fait
 * dans un fichier data/billetterie.json (alimente par seed.js). Si l'e-mail est
 * inconnu, on fabrique un billet coherent avec la repartition annoncee
 * (80 % Humains, 15 % Saiyans, 5 % Super Saiyans), de facon deterministe :
 * le meme e-mail donnera toujours le meme statut, ce qui rend les
 * demonstrations reproductibles.
 *
 * Brancher la vraie billetterie du parc reviendrait a remplacer ce seul
 * fichier par un appel HTTP.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FICHIER = path.join('data', 'billetterie.json');

function lireRegistre() {
  try {
    return JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  } catch {
    return {};
  }
}

export function ecrireRegistre(registre) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(FICHIER, JSON.stringify(registre, null, 2));
}

/** Entier stable dans [0, 100[ derive de l'e-mail. */
function empreinte(email) {
  const h = createHash('sha256').update(email.toLowerCase()).digest();
  return h[0] % 100;
}

/**
 * Retourne le billet associe a un e-mail.
 * @returns {{prenom:string, initiale:string, statut:string, refBillet:string, anneeNaissance:number|null}}
 */
export function chercherBillet(email) {
  const registre = lireRegistre();
  const connu = registre[email.toLowerCase()];
  if (connu) return connu;

  const n = empreinte(email);
  // 0-4 : Super Saiyan (5 %) / 5-19 : Saiyan (15 %) / 20-99 : Humain (80 %)
  const statut = n < 5 ? 'SUPER_SAIYAN' : n < 20 ? 'SAIYAN' : 'HUMAIN';

  // Prenom et initiale : seules donnees nominatives conservees (chapitre 7).
  const base = email.split('@')[0].replace(/[^a-zA-Z]/g, '') || 'Visiteur';
  const prenom = base.charAt(0).toUpperCase() + base.slice(1, 12).toLowerCase();

  return {
    prenom,
    initiale: prenom.charAt(0),
    statut,
    refBillet: `BIL-${String(n).padStart(2, '0')}${empreinte(email + 'x')}`,
    anneeNaissance: null,   // renseigne uniquement si une regle d'age s'applique
  };
}
