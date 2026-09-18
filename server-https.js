import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

import { chargerJournee, etat } from './src/domain/eventStore.js';
import { battement } from './src/domain/scheduler.js';
import { etatHorloge } from './src/domain/clock.js';
import { creerApplication } from './src/api/http.js';
import { enregistrerRoutes, diffuserEtat } from './src/api/routes.js';

/*
 * Serveur HTTPS de test pour le mobile.
 *
 * Ce fichier sert uniquement a lancer l'application dans un contexte secure
 * (HTTPS), ce qui est souvent requis par les navigateurs mobiles pour
 * autoriser l'acces a la camera.
 *
 * On garde le meme moteur applicatif que le serveur HTTP normal : routes API,
 * fichiers statiques, flux SSE et ordonnanceur. On change seulement le type
 * de serveur, pas la logique metier.
 */
const PORT = Number(process.env.PORT) || 3000;
const root = process.cwd();
const certDir = path.join(root, 'certs');
const cert = fs.readFileSync(path.join(certDir, 'cert.local.crt'));
const key = fs.readFileSync(path.join(certDir, 'cert.local.key'));

chargerJournee();

const app = creerApplication({
  dossierStatique: 'public',
  /*
   * Permet de reutiliser exactement la meme application que le serveur HTTP,
   * mais sans toucher a la logique metier : on injecte ici le moteur HTTPS.
   */
  serveurFactory: (handler) => https.createServer({ key, cert }, handler),
});

enregistrerRoutes(app);
app.ecouter(PORT, '0.0.0.0');

let enCours = false;
async function boucle() {
  if (!enCours) {
    enCours = true;
    try {
      await battement();
      diffuserEtat();
    } catch (e) {
      console.error('[ordonnanceur]', e);
    } finally {
      enCours = false;
    }
  }
  setTimeout(boucle, etat().regles.periodeTickMs);
}
boucle();

const h = etatHorloge();
console.log(`
  Waitless — La Salle du Temps (HTTPS)
  ---------------------------------------------
  Application    https://localhost:${PORT}
  Interface LAN https://192.168.106.75:${PORT}
  Heure simulee  ${h.heure} (vitesse x${h.vitesse})
  Journee        ${etat().jour}
  Codes          agent ${etat().regles.codeAgent} / admin ${etat().regles.codeAdmin}
  ---------------------------------------------
`);

process.on('SIGINT', () => {
  console.log('\nArret. Le journal d\'evenements est complet, relancez pour reprendre.');
  process.exit(0);
});
