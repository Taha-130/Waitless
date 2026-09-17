/**
 * ---------------------------------------------------------------------------
 * SCRIPT DE PEUPLEMENT
 * ---------------------------------------------------------------------------
 *   node seed.js                 -> 24 visiteurs dans la file
 *   node seed.js --nombre=40     -> 40 visiteurs
 *   node seed.js --heure=17:30   -> positionne l'horloge avant de peupler
 *   node seed.js --vitesse=60    -> 1 minute simulee par seconde reelle
 *   node seed.js --reset         -> efface la journee et repart de zero
 *
 * A lancer serveur ARRETE (les deux processus ecriraient dans le meme journal).
 * Le tableau de bord propose le meme peuplement en un clic, serveur allume.
 * ---------------------------------------------------------------------------
 */

import { chargerJournee, effacerJournee, etat } from './src/domain/eventStore.js';
import { reglerHorloge, etatHorloge, minutesDuJour } from './src/domain/clock.js';
import { semer } from './src/infra/jeuDeDonnees.js';
import { viderBoite } from './src/infra/mailer.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [cle, valeur] = a.replace(/^--/, '').split('=');
    return [cle, valeur ?? true];
  }),
);

if (args.reset) {
  effacerJournee();
  viderBoite();
  console.log('Journee effacee.');
} else {
  chargerJournee();
}

// Regle l'horloge si demande, ou automatiquement si l'heure simulee tombe hors
// des horaires d'exploitation (sinon toutes les inscriptions seraient refusees,
// ce qui est correct mais peu pratique pour demarrer).
const r = etat().regles;
if (args.heure || args.vitesse) {
  reglerHorloge({ heure: args.heure, vitesse: args.vitesse ? Number(args.vitesse) : undefined });
} else if (minutesDuJour() < r.ouvertureFile || minutesDuJour() >= r.finExploitation) {
  reglerHorloge({ heure: '10:00', vitesse: 1 });
  console.log("Horloge positionnee a 10:00 (hors horaires d'exploitation).");
}

if (!args.reset) {
  const { inscrits, refuses } = semer(Number(args.nombre) || 24);
  console.log(`${inscrits} visiteur(s) inscrit(s).`);
  if (refuses.length) {
    console.log(`${refuses.length} refus (regles metier) :`);
    for (const x of refuses.slice(0, 5)) console.log(`  - ${x.email} : ${x.motif}`);
  }
}

const h = etatHorloge();
console.log(`Heure simulee : ${h.heure} (vitesse x${h.vitesse}). Lancez maintenant : node server.js`);
