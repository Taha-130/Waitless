/**
 * ---------------------------------------------------------------------------
 * WAITLESS — POINT D'ENTREE
 * ---------------------------------------------------------------------------
 * Demarrage :  node server.js
 *
 * Trois choses se passent ici, et rien d'autre :
 *   1. on reconstruit l'etat en rejouant le journal de la journee (RG-13) ;
 *   2. on monte le serveur HTTP et ses routes ;
 *   3. on lance le battement de l'ordonnanceur.
 *
 * Toute la logique metier est dans src/domain. Ce fichier ne contient aucune
 * regle : on doit pouvoir le lire en trente secondes.
 * ---------------------------------------------------------------------------
 */

import { chargerJournee, etat } from './src/domain/eventStore.js';
import { battement } from './src/domain/scheduler.js';
import { etatHorloge } from './src/domain/clock.js';
import { creerApplication } from './src/api/http.js';
import { enregistrerRoutes, diffuserEtat } from './src/api/routes.js';

const PORT = Number(process.env.PORT) || 3000;

// 1. Reprise : l'etat vient du journal, jamais d'une variable perdue au reboot.
chargerJournee();

// 2. API + interfaces.
const app = creerApplication({ dossierStatique: 'public' });
enregistrerRoutes(app);
app.ecouter(PORT);

// 3. Battement de l'ordonnanceur.
// La periode est une regle modifiable : on relit l'intervalle a chaque tour
// plutot que de figer un setInterval.
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
  Waitless — La Salle du Temps
  ---------------------------------------------
  Application    http://localhost:${PORT}
  Heure simulee  ${h.heure} (vitesse x${h.vitesse})
  Journee        ${etat().jour}
  Codes          agent ${etat().regles.codeAgent} / admin ${etat().regles.codeAdmin}
  ---------------------------------------------
  Ctrl+C pour arreter. L'etat est conserve dans data/.
`);

// Arret propre : rien a sauvegarder, le journal est deja sur le disque.
process.on('SIGINT', () => {
  console.log('\nArret. Le journal d\'evenements est complet, relancez pour reprendre.');
  process.exit(0);
});
