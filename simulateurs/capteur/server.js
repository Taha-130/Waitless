/**
 * ---------------------------------------------------------------------------
 * CAPTEUR DE SALLE — service externe simule
 * ---------------------------------------------------------------------------
 * Joue le role du capteur physique de la Salle du Temps, consomme par
 * Waitless via `WAITLESS_CAPTEUR_URL` (voir src/infra/sensor.js).
 *
 * Repond sur GET / : { "count": N }, N variant dans le temps comme une vraie
 * salle qui se remplit et se vide (onde sinusoidale bornee entre 10 % et
 * 90 % de la capacite).
 *
 * Volontairement sans dependance, un seul fichier.
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';

const PORT = Number(process.env.PORT) || 4002;
const CAPACITE = 50;
const DEBUT = Date.now();

function occupationSimulee() {
  const minutes = (Date.now() - DEBUT) / 60_000;
  // Cycle de 10 minutes, entre 10% et 90% de la capacite.
  const onde = Math.sin((minutes / 10) * 2 * Math.PI);
  return Math.round(CAPACITE * (0.5 + 0.4 * onde));
}

const serveur = http.createServer((req, res) => {
  const count = occupationSimulee();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ count }));
});

serveur.listen(PORT, () => {
  console.log(`[capteur] service simule sur le port ${PORT} (capacite ${CAPACITE})`);
});
