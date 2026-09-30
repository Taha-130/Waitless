/**
 * ---------------------------------------------------------------------------
 * SCRIPT DE PEUPLEMENT
 * ---------------------------------------------------------------------------
 *   node seed.js                 -> 24 visiteurs dans la file virtuelle
 *   node seed.js --nombre=40     -> 40 visiteurs
 *   node seed.js --arrivees=12   -> dont 12 deja arrives dans la file reelle
 *   node seed.js --entrees=6     -> dont 6 deja entres dans la Salle du Temps
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
  const { inscrits, arrivees, entrees, refuses } = semer(Number(args.nombre) || 24, {
    arrivees: Number(args.arrivees) || 0,
    entrees: Number(args.entrees) || 0,
  });
  console.log(`${inscrits} visiteur(s) inscrit(s) dans la file virtuelle.`);
  if (arrivees) console.log(`${arrivees} arrive(s) dans la file reelle (1er scan).`);
  if (entrees) console.log(`${entrees} entre(s) dans la Salle du Temps (2e scan).`);
  if (refuses.length) {
    console.log(`${refuses.length} refus (regles metier) :`);
    for (const x of refuses.slice(0, 5)) console.log(`  - ${x.email} : ${x.motif}`);
  }
}

const h = etatHorloge();
console.log(`Heure simulee : ${h.heure} (vitesse x${h.vitesse}). Lancez maintenant : node server.js`);
