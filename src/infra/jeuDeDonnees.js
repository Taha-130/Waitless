/**
 * ---------------------------------------------------------------------------
 * JEU DE DONNEES FICTIF
 * ---------------------------------------------------------------------------
 * Alimente la billetterie simulee puis fait entrer des visiteurs dans la file
 * en passant par les VRAIES commandes metier. Aucun raccourci : le jeu d'essai
 * emprunte exactement le meme chemin qu'un vrai visiteur, ce qui garantit que
 * ce qu'on demontre est bien ce qui fonctionne.
 *
 * Repartition conforme aux hypotheses du cahier : ~80 % Humains, ~15 % Saiyans,
 * ~5 % Super Saiyans.
 * ---------------------------------------------------------------------------
 */

import { ecrireRegistre } from './billetterie.js';
import {
  enregistrerVisiteur, donnerConsentements, declarerAptitude, rejoindreFile,
  scanner, ETAPES_SCAN,
} from '../domain/commands.js';
import { ordonnancer } from '../domain/scheduler.js';
import { etat } from '../domain/eventStore.js';
import { genererJeton } from '../domain/qr.js';
import { ticketsConvoques, ticketsFileReelle } from '../domain/state.js';

const PRENOMS = [
  'Lea', 'Karim', 'Sofia', 'Noah', 'Ines', 'Malo', 'Jade', 'Elias', 'Rose', 'Adam',
  'Chloe', 'Nino', 'Anna', 'Youssef', 'Mila', 'Gabin', 'Lina', 'Theo', 'Sarah', 'Ilan',
  'Zoe', 'Hugo', 'Nour', 'Basile', 'Alice', 'Ryan', 'Eva', 'Milo', 'Salma', 'Tom',
];

/** Statut du i-eme visiteur, pour respecter la repartition annoncee. */
function statutPour(i) {
  const reste = i % 20;
  if (reste === 0) return 'SUPER_SAIYAN';   // 1 sur 20 = 5 %
  if (reste <= 3) return 'SAIYAN';          // 3 sur 20 = 15 %
  return 'HUMAIN';                          // 16 sur 20 = 80 %
}

/**
 * Cree `nombre` visiteurs et les inscrit dans la file virtuelle, puis, si on le
 * demande, fait avancer une partie d'entre eux dans les deux etages suivants.
 *
 * Peupler les trois etages d'un coup evite la demonstration trompeuse ou tout
 * le monde est dans le parc : on veut voir, des la premiere seconde, une file
 * reelle qui se remplit et une salle qui se remplit moins vite.
 *
 * @param {number} nombre
 * @param {{arrivees?:number, entrees?:number}} etapes
 * @returns {{inscrits:number, arrivees:number, entrees:number, refuses:Array}}
 */
export function semer(nombre = 24, { arrivees = 0, entrees = 0 } = {}) {
  // 1. La billetterie du parc « connait » ces visiteurs et leur statut.
  const registre = {};
  for (let i = 0; i < nombre; i++) {
    const prenom = PRENOMS[i % PRENOMS.length];
    const email = `${prenom.toLowerCase()}${i}@exemple.fr`;
    registre[email] = {
      prenom,
      initiale: prenom.charAt(0),
      statut: statutPour(i),
      refBillet: `BIL-${String(1000 + i)}`,
      anneeNaissance: null,
    };
  }
  ecrireRegistre(registre);

  // 2. Chaque visiteur suit le parcours complet : connexion, consentement,
  //    aptitude, puis inscription.
  const refuses = [];
  let inscrits = 0;

  for (const email of Object.keys(registre)) {
    try {
      const v = enregistrerVisiteur(email);
      donnerConsentements(v.id, { cgu: true, decharge: true });
      declarerAptitude(v.id, true);
      rejoindreFile(v.id);
      inscrits++;
    } catch (e) {
      // Une inscription refusee n'est pas un bug : c'est une regle qui joue
      // (fermeture automatique, garantie Saiyan intenable...).
      refuses.push({ email, motif: e.message });
    }
  }

  ordonnancer(etat());

  // 3. Une partie des convoques se presente devant l'attraction (1er scan),
  //    et une partie de ceux-la entre dans la salle (2e scan). On passe par le
  //    vrai chemin de scan, jeton compris : rien n'est force dans le journal.
  const arrivesReels = avancerEtape(arrivees, ticketsConvoques, ETAPES_SCAN.ARRIVEE);
  const entresReels = avancerEtape(entrees, ticketsFileReelle, ETAPES_SCAN.ENTREE);

  ordonnancer(etat());   // les places liberees repartent aussitot
  return { inscrits, arrivees: arrivesReels, entrees: entresReels, refuses };
}

/** Scanne les `nombre` premiers tickets d'un etage vers le suivant. */
function avancerEtape(nombre, selecteur, etape) {
  let faits = 0;
  for (let i = 0; i < nombre; i++) {
    const t = selecteur(etat())[0];
    if (!t) break;
    const { jeton } = genererJeton(t.id, etat().regles.validiteJetonQrSec);
    if (scanner(jeton, 'agent', etape).verdict === 'REFUSE') break;
    faits++;
  }
  return faits;
}
