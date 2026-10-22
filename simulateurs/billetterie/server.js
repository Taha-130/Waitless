/**
 * ---------------------------------------------------------------------------
 * BILLETTERIE — service externe simule
 * ---------------------------------------------------------------------------
 * Joue le role du systeme de billetterie du parc, consomme par Waitless via
 * `WAITLESS_BILLETTERIE_URL` (voir src/infra/billetterie.js dans Waitless).
 *
 * Repond sur GET / le contenu de visiteurs.json : un objet indexe par e-mail
 * { "email": { "prenom": "...", "statut": "HUMAIN|SAIYAN|SUPER_SAIYAN", ... } },
 * le format attendu par Waitless.
 *
 * Volontairement sans dependance (comme Waitless) : pas de base de donnees,
 * un simple fichier JSON suffit a un service dont le role est de renvoyer
 * une liste de visiteurs de demo.
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4001;
const FICHIER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'visiteurs.json');

function lireVisiteurs() {
  return JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
}

const serveur = http.createServer((req, res) => {
  const visiteurs = lireVisiteurs();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(visiteurs));
});

serveur.listen(PORT, () => {
  console.log(`[billetterie] service simule sur le port ${PORT} (${Object.keys(lireVisiteurs()).length} visiteurs)`);
});
