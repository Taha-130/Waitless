/**
 * ---------------------------------------------------------------------------
 * TESTS DES REGLES METIER
 * ---------------------------------------------------------------------------
 *   node --test test/*.test.js
 *
 * Un test par regle critique, plus les regles propres au modele a trois etages
 * (file virtuelle -> file reelle -> Salle du Temps). Aucun serveur n'est
 * demarre : on appelle les commandes du domaine directement, ce qui est
 * precisement l'interet d'avoir garde le metier hors de HTTP.
 *
 * Les tests travaillent dans un dossier temporaire : lancer la suite n'efface
 * jamais le journal de la journee en cours. D'ou les imports dynamiques, apres
 * le changement de repertoire — les modules ecrivent dans `data/`, relatif au
 * repertoire courant au moment du chargement.
 * ---------------------------------------------------------------------------
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'waitless-test-'));
process.chdir(bac);
process.env.WAITLESS_SILENCIEUX = '1';   // pas de bruit de « mails » dans la sortie

const { REGLES_PAR_DEFAUT, validerRegles } = await import('../src/config/rules.js');
const { chargerJournee, effacerJournee, etat, publier } = await import('../src/domain/eventStore.js');
const { reglerHorloge, maintenant } = await import('../src/domain/clock.js');
const { ETATS_TICKET, ticketsFileReelle, ticketsEnAttente, occupationFileReelle } =
  await import('../src/domain/state.js');
const {
  enregistrerVisiteur, donnerConsentements, declarerAptitude, rejoindreFile,
  seDesister, retirerTicket, mettreEnPause, reprendre, purger, scanner,
  modifierRegles, etatInscriptions, ETAPES_SCAN,
} = await import('../src/domain/commands.js');
const { ordonnancer, battement, resteGarantieMin, comptageFenetre } =
  await import('../src/domain/scheduler.js');
const { genererJeton } = await import('../src/domain/qr.js');
const { forcerOccupation, reinitialiserCapteur, releverCapteur, dernierReleve } =
  await import('../src/infra/sensor.js');
const { ecrireRegistre } = await import('../src/infra/billetterie.js');
const { vueFile, vueTicket, vueFileAgent } = await import('../src/api/views.js');

/* ------------------------------------------------------------------------ */
/* Outillage                                                                 */
/* ------------------------------------------------------------------------ */

let compteur = 0;

/** Remet une journee vierge, horloge a 10h00, capteur a zero. */
function journeeNeuve(regles = {}) {
  reglerHorloge({ heure: '10:00', vitesse: 0 });   // vitesse 0 : le temps ne coule pas
  reinitialiserCapteur();
  effacerJournee();                                 // efface puis recharge la journee
  if (Object.keys(regles).length) publier('REGLES_MODIFIEES', { regles });
  return etat();
}

/** Cree un visiteur pret a s'inscrire, avec le statut voulu. */
function visiteur(statut = 'HUMAIN') {
  const email = `v${++compteur}@exemple.fr`;
  ecrireRegistre({
    ...lireRegistreSilencieux(),
    [email]: { prenom: `V${compteur}`, initiale: 'V', statut, refBillet: `BIL-${compteur}`, anneeNaissance: null },
  });
  const v = enregistrerVisiteur(email);
  donnerConsentements(v.id, { cgu: true, decharge: true });
  declarerAptitude(v.id, true);
  return v;
}

function lireRegistreSilencieux() {
  try { return JSON.parse(fs.readFileSync(path.join('data', 'billetterie.json'), 'utf8')); }
  catch { return {}; }
}

/** Inscrit n visiteurs d'un statut donne et renvoie leurs tickets. */
function inscrire(n, statut = 'HUMAIN') {
  const tickets = [];
  for (let i = 0; i < n; i++) tickets.push(rejoindreFile(visiteur(statut).id));
  return tickets;
}

/** Avance l'horloge simulee de `minutes`. */
function avancer(minutes) {
  const d = new Date(maintenant() + minutes * 60_000);
  reglerHorloge({ heure: `${d.getHours()}:${d.getMinutes()}`, vitesse: 0 });
}

/** Scanne le ticket : jeton genere a la volee, comme le ferait le telephone. */
function scannerTicket(ticketId, etape = ETAPES_SCAN.AUTO) {
  const { jeton } = genererJeton(ticketId, etat().regles.validiteJetonQrSec);
  return scanner(jeton, 'agent', etape);
}

/** Fait entrer un ticket dans la salle : convocation, arrivee, entree. */
function faireEntrer(ticket) {
  if (etat().tickets[ticket.id].etat === ETATS_TICKET.EN_ATTENTE) ordonnancer(etat());
  scannerTicket(ticket.id, ETAPES_SCAN.ARRIVEE);
  return scannerTicket(ticket.id, ETAPES_SCAN.ENTREE);
}

/* ======================================================================== */
/* RG-01 — Horaires d'ouverture et d'exploitation                            */
/* ======================================================================== */

test('RG-01 : aucune inscription avant l\'ouverture de la file', () => {
  journeeNeuve();
  reglerHorloge({ heure: '07:30', vitesse: 0 });
  const v = visiteur();
  assert.throws(() => rejoindreFile(v.id), /ouvrent à 08h00/);
});

test('RG-01 : aucune convocation avant le debut d\'exploitation', () => {
  journeeNeuve();
  reglerHorloge({ heure: '08:30', vitesse: 0 });   // file ouverte, exploitation non
  const [t] = inscrire(1);
  assert.equal(ordonnancer(etat()).length, 0);
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.EN_ATTENTE);
});

/* ======================================================================== */
/* RG-02 — Session, consentement, aptitude, un seul ticket                   */
/* ======================================================================== */

test('RG-02 : sans consentement, sans aptitude ou avec un ticket, on n\'entre pas', () => {
  journeeNeuve();

  const sansConsentement = enregistrerVisiteur('rien@exemple.fr');
  assert.throws(() => rejoindreFile(sansConsentement.id), /décharge/i);

  const nonApte = enregistrerVisiteur('nonapte@exemple.fr');
  donnerConsentements(nonApte.id, { cgu: true, decharge: true });
  declarerAptitude(nonApte.id, false);
  assert.throws(() => rejoindreFile(nonApte.id), /conditions d'accès/);

  const v = visiteur();
  rejoindreFile(v.id);
  assert.throws(() => rejoindreFile(v.id), /déjà un ticket/);
});

/* ======================================================================== */
/* RG-03 — Rang d'arrivee immuable                                           */
/* ======================================================================== */

test('RG-03 : le rang d\'arrivee ne change jamais, meme apres depassement', () => {
  journeeNeuve();
  const [a, b] = inscrire(2);
  const rangs = { a: a.rang, b: b.rang };

  // Un Super Saiyan arrive apres et passe devant : les rangs ne bougent pas.
  const prioritaire = inscrire(1, 'SUPER_SAIYAN')[0];
  ordonnancer(etat());

  assert.equal(etat().tickets[a.id].rang, rangs.a);
  assert.equal(etat().tickets[b.id].rang, rangs.b);
  assert.ok(prioritaire.rang > rangs.b, 'le prioritaire garde son rang d\'arrivee tardif');
  assert.equal(etat().tickets[prioritaire.id].etat, ETATS_TICKET.CONVOQUE);
});

/* ======================================================================== */
/* RG-04 — Fermeture automatique des inscriptions                            */
/* ======================================================================== */

test('RG-04 : les inscriptions ferment quand le passage n\'est plus garantissable', () => {
  journeeNeuve();
  reglerHorloge({ heure: '18:55', vitesse: 0 });   // 5 min avant la fin
  const e = etatInscriptions(etat(), 'HUMAIN');
  assert.equal(e.ouvert, false);
  assert.match(e.motif, /Plus assez de temps/);
});

test('RG-04 : l\'heure limite tient compte de la file reelle, pas seulement de la file virtuelle', () => {
  journeeNeuve();
  const sansPersonne = etatInscriptions(etat(), 'HUMAIN').heureLimite;

  // 30 personnes convoquees puis arrivees devant l'attraction.
  const tickets = inscrire(30);
  ordonnancer(etat());
  for (const t of tickets) scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);

  const avecFileReelle = etatInscriptions(etat(), 'HUMAIN').heureLimite;
  assert.ok(avecFileReelle < sansPersonne,
    'la file reelle avance l\'heure de fermeture des inscriptions');
});

/* ======================================================================== */
/* RG-05 — Seuil de vigilance de fin de journee                              */
/* ======================================================================== */

test('RG-05 : les inscrits menaces par la fermeture sont avertis une seule fois', async () => {
  journeeNeuve({ capaciteSalle: 2, capaciteFileReelle: 1, dureeSejourMinSec: 3600, dureeSejourMaxSec: 3600 });
  const tickets = inscrire(20);
  reglerHorloge({ heure: '18:00', vitesse: 0 });

  await battement();
  await battement();   // second passage : il ne doit rien reenvoyer

  const avertis = tickets.filter((t) => etat().tickets[t.id].avertiFinJournee).length;
  const evenements = fs.readFileSync(
    path.join('data', `evenements-${etat().jour}.jsonl`), 'utf8',
  ).split('\n').filter((l) => l.includes('VIGILANCE_ENVOYEE')).length;

  assert.ok(avertis > 0, 'au moins un visiteur est averti');
  assert.equal(evenements, avertis, 'un seul avertissement par ticket (F-07)');
});

/* ======================================================================== */
/* RG-06 — Super Saiyan prioritaire, plafonne sur la fenetre glissante        */
/* ======================================================================== */

test('RG-06 : un Super Saiyan est convoque immediatement, devant les autres', () => {
  journeeNeuve();
  inscrire(5, 'HUMAIN');
  const ss = inscrire(1, 'SUPER_SAIYAN')[0];
  ordonnancer(etat());
  assert.equal(etat().tickets[ss.id].etat, ETATS_TICKET.CONVOQUE);
});

test('RG-06 : les Super Saiyans ne depassent pas 15 % des convocations', () => {
  journeeNeuve();
  inscrire(40, 'SUPER_SAIYAN');
  inscrire(40, 'HUMAIN');
  ordonnancer(etat());

  const { parStatut, total } = comptageFenetre(etat());
  const part = (parStatut.SUPER_SAIYAN || 0) / total;
  assert.ok(part <= 0.15 + 1e-9,
    `part Super Saiyan = ${Math.round(part * 100)} %, attendu au plus 15 %`);
  assert.ok((parStatut.SUPER_SAIYAN || 0) > 0, 'mais ils passent bien devant');
});

/* ======================================================================== */
/* RG-07 — Garantie Saiyan ou fermeture des inscriptions                     */
/* ======================================================================== */

test('RG-07 : les inscriptions Saiyan ferment si la garantie de 30 min est intenable', () => {
  // Un Saiyan double les Humains de la file virtuelle : ce n'est donc jamais
  // elle qui met sa garantie en peril, mais la file REELLE, qu'il ne double
  // pas, et une salle qui se libere trop lentement.
  journeeNeuve({ capaciteSalle: 1, capaciteFileReelle: 30, dureeSejourMinSec: 3600, dureeSejourMaxSec: 3600 });
  inscrire(30, 'HUMAIN');
  ordonnancer(etat());   // les 30 partent occuper la file reelle

  const e = etatInscriptions(etat(), 'SAIYAN');
  assert.equal(e.ouvert, false);
  assert.match(e.motif, /garantie à 30 min/);

  // Un Humain, lui, peut toujours s'inscrire : on ne lui a rien promis.
  assert.equal(etatInscriptions(etat(), 'HUMAIN').ouvert, true);
});

test('RG-07 : la garantie Saiyan se mesure jusqu\'a la convocation, et s\'y fige', () => {
  journeeNeuve();
  const [t] = inscrire(1, 'SAIYAN');
  assert.ok(resteGarantieMin(etat(), etat().tickets[t.id]) <= 30);

  ordonnancer(etat());
  const resteALaConvocation = resteGarantieMin(etat(), etat().tickets[t.id]);

  avancer(45);   // le visiteur traine, puis patiente longuement sur place
  assert.equal(
    resteGarantieMin(etat(), etat().tickets[t.id]), resteALaConvocation,
    'une fois convoque, le compteur de garantie ne bouge plus',
  );
});

/* ======================================================================== */
/* RG-08 — Part minimale reservee aux Humains                                */
/* ======================================================================== */

test('RG-08 : les Humains ne sont pas affames par les prioritaires', () => {
  journeeNeuve();
  inscrire(20, 'SAIYAN');
  inscrire(20, 'HUMAIN');
  ordonnancer(etat());

  const { parStatut, total } = comptageFenetre(etat());
  assert.ok((parStatut.HUMAIN || 0) > 0, 'des Humains sont convoques');
  assert.ok((parStatut.HUMAIN || 0) / total >= 0.4,
    `part Humaine = ${Math.round(((parStatut.HUMAIN || 0) / total) * 100)} %, attendu au moins 40 %`);
});

/* ======================================================================== */
/* RG-09 — Convocation : 10 minutes pour REJOINDRE LA FILE REELLE            */
/* ======================================================================== */

test('RG-09 : le delai de convocation porte sur le trajet, pas sur l\'attente sur place', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());

  avancer(9);
  const arrivee = scannerTicket(t.id);
  assert.equal(arrivee.verdict, 'ARRIVEE');
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.EN_FILE_REELLE);
});

test('RG-09 : au-dela du delai et de la grace, l\'arrivee est refusee', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());

  avancer(13);   // 10 min + 2 min de grace depassees
  const r = scannerTicket(t.id);
  assert.equal(r.verdict, 'REFUSE');
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.EXPIRE);
});

/* ======================================================================== */
/* RG-10 — Expiration et reattribution de la place                           */
/* ======================================================================== */

test('RG-10 : l\'absent expire et sa place revient au suivant', async () => {
  journeeNeuve({ capaciteFileReelle: 1 });
  const [absent, suivant] = inscrire(2);

  ordonnancer(etat());
  assert.equal(etat().tickets[absent.id].etat, ETATS_TICKET.CONVOQUE);
  assert.equal(etat().tickets[suivant.id].etat, ETATS_TICKET.EN_ATTENTE,
    'la file reelle d\'une place ne convoque qu\'une personne');

  avancer(13);
  await battement();

  assert.equal(etat().tickets[absent.id].etat, ETATS_TICKET.EXPIRE);
  assert.equal(etat().tickets[suivant.id].etat, ETATS_TICKET.CONVOQUE,
    'la place liberee est aussitot reattribuee');
});

test('RG-10 : un visiteur arrive dans la file reelle n\'expire JAMAIS', async () => {
  journeeNeuve({ capaciteSalle: 1 });
  const [occupant, patient] = inscrire(2);

  ordonnancer(etat());
  faireEntrer(occupant);                         // il occupe l'unique place
  scannerTicket(patient.id, ETAPES_SCAN.ARRIVEE);

  avancer(120);                                  // deux heures de patience
  await battement();

  assert.equal(etat().tickets[patient.id].etat, ETATS_TICKET.EN_FILE_REELLE,
    'present devant l\'agent, il ne peut pas etre declare absent');
});

/* ======================================================================== */
/* RG-11 — L'agent n'ajoute personne ; tout acte exige un motif               */
/* ======================================================================== */

test('RG-11 : aucune route ni commande ne permet a un operateur d\'ajouter un ticket', () => {
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  const appels = routes.match(/rejoindreFile\s*\(/g) || [];
  assert.equal(appels.length, 1, 'rejoindreFile n\'est appelee qu\'une fois dans les routes');
  assert.match(routes, /app\.post\('\/api\/queues\/:id\/tickets'[\s\S]{0,120}exigerVisiteur/);
  assert.equal(/app\.(post|put)\('\/api\/(agent|admin)\/tickets/.test(routes), false,
    'aucune route de creation de ticket cote agent ou admin');
});

test('RG-11 : retrait, pause et purge exigent un motif', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  assert.throws(() => retirerTicket(t.id, '', 'agent'), /motif est obligatoire/);
  assert.throws(() => mettreEnPause('  ', 'agent'), /motif est obligatoire/);
  assert.throws(() => purger(null, 'agent'), /motif est obligatoire/);
  retirerTicket(t.id, 'Comportement dangereux', 'agent');
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.RETIRE);
});

test('RG-11 : un agent peut retirer quelqu\'un de la file reelle (parti sans le dire)', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());
  scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);

  retirerTicket(t.id, 'Visiteur parti sans prevenir', 'agent');
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.RETIRE);
  assert.equal(occupationFileReelle(etat()), 0, 'la place est rendue a la file reelle');
});

/* ======================================================================== */
/* RG-12 — La pause gele et restitue les compteurs                           */
/* ======================================================================== */

test('RG-12 : la pause gele le compte a rebours et le restitue a l\'identique', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());

  avancer(3);
  const avant = vueTicket(etat(), etat().tickets[t.id]).resteSec;

  mettreEnPause('Panne du sas', 'agent');
  avancer(30);
  assert.equal(vueTicket(etat(), etat().tickets[t.id]).resteSec, avant,
    'le compteur ne bouge pas pendant la pause');

  reprendre('agent');
  assert.equal(vueTicket(etat(), etat().tickets[t.id]).resteSec, avant,
    'et il repart exactement ou il s\'etait arrete');
});

test('RG-12 : aucun scan n\'est accepte pendant une pause', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());
  mettreEnPause('Evacuation', 'agent');
  const r = scannerTicket(t.id);
  assert.equal(r.verdict, 'REFUSE');
  assert.match(r.motif, /pause/i);
});

/* ======================================================================== */
/* RG-13 — Conservation de l'ordre apres panne                               */
/* ======================================================================== */

test('RG-13 : apres un arret brutal, rangs, etages et convocations sont intacts', () => {
  journeeNeuve();
  const tickets = inscrire(8);
  ordonnancer(etat());
  scannerTicket(tickets[0].id, ETAPES_SCAN.ARRIVEE);
  faireEntrer(tickets[1]);

  const avant = Object.values(etat().tickets)
    .map((t) => `${t.rang}:${t.etat}`).sort().join('|');
  const fileReelleAvant = ticketsFileReelle(etat()).map((t) => t.id);

  chargerJournee();   // simule le redemarrage : l'etat est rejoue depuis zero

  const apres = Object.values(etat().tickets)
    .map((t) => `${t.rang}:${t.etat}`).sort().join('|');
  assert.equal(apres, avant);
  assert.deepEqual(ticketsFileReelle(etat()).map((t) => t.id), fileReelleAvant,
    'l\'ordre physique de la file reelle survit au redemarrage');
});

/* ======================================================================== */
/* RG-14 — Desistement definitif, QR revoque                                 */
/* ======================================================================== */

test('RG-14 : apres desistement, le code ne vaut plus rien', () => {
  journeeNeuve();
  const v = visiteur();
  const t = rejoindreFile(v.id);
  ordonnancer(etat());

  seDesister(v.id);
  assert.equal(etat().tickets[t.id].etat, ETATS_TICKET.ANNULE);

  const r = scannerTicket(t.id);
  assert.equal(r.verdict, 'REFUSE');
  assert.match(r.motif, /annulé/i);
});

/* ======================================================================== */
/* RG-15 — Seuils modifiables sans redeploiement                             */
/* ======================================================================== */

test('RG-15 : une regle valide s\'applique a chaud, une regle hors bornes est refusee', () => {
  journeeNeuve();
  const { ok, valeurs } = validerRegles({ capaciteFileReelle: '12' });
  assert.equal(ok, true);
  modifierRegles(valeurs, 'admin');
  assert.equal(etat().regles.capaciteFileReelle, 12);

  const refus = validerRegles({ capaciteSalle: 0 });
  assert.equal(refus.ok, false);
  assert.match(refus.erreurs[0], /hors bornes/);

  // Coherence : une file reelle plus grande que la salle n'a pas de sens.
  assert.equal(validerRegles({ capaciteFileReelle: 400, capaciteSalle: 50 }).ok, false);
  // Coherence : la duree minimale de sejour ne peut pas depasser la maximale.
  assert.equal(validerRegles({ dureeSejourMinSec: 150, dureeSejourMaxSec: 120 }).ok, false);
  assert.equal(validerRegles({ dureeSejourMinSec: 30, dureeSejourMaxSec: 120 }).ok, true);
  assert.equal(etat().audit.some((a) => a.action === 'REGLES_MODIFIEES'), true,
    'la modification est tracee dans l\'audit');
});

/* ======================================================================== */
/* RG-16 — La file reelle ne depasse jamais sa capacite                      */
/* ======================================================================== */

test('RG-16 : l\'ordonnanceur s\'arrete a 30 personnes engagees dans la file reelle', () => {
  journeeNeuve();
  inscrire(80);
  ordonnancer(etat());

  assert.equal(occupationFileReelle(etat()), 30,
    'exactement 30 places, convoques en route compris');
  assert.equal(ticketsEnAttente(etat()).length, 50, 'les autres restent dans le parc');
});

test('RG-16 : les convoques en route comptent dans les 30 places', () => {
  journeeNeuve();
  const tickets = inscrire(50);
  ordonnancer(etat());

  // 10 arrivent, 20 sont encore en chemin : l'ordonnanceur ne doit convoquer
  // personne de plus, sans quoi la file deborderait a leur arrivee.
  for (const t of tickets.slice(0, 10)) scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);
  ordonnancer(etat());

  assert.equal(occupationFileReelle(etat()), 30);
  assert.equal(ticketsFileReelle(etat()).length, 10);
});

test('RG-16 : une place liberee dans la file reelle declenche une convocation', () => {
  journeeNeuve({ capaciteSalle: 60 });
  const tickets = inscrire(40);
  ordonnancer(etat());
  assert.equal(ticketsEnAttente(etat()).length, 10);

  faireEntrer(tickets[0]);          // il quitte la file reelle pour la salle
  ordonnancer(etat());

  assert.equal(ticketsEnAttente(etat()).length, 9, 'le suivant est aussitot appele');
  assert.equal(occupationFileReelle(etat()), 30);
});

/* ======================================================================== */
/* RG-17 — La salle ne depasse jamais 50, et un refus ne punit personne      */
/* ======================================================================== */

test('RG-17 : salle pleine, l\'entree est refusee SANS consommer le code', () => {
  journeeNeuve({ capaciteSalle: 2 });
  const tickets = inscrire(3);
  ordonnancer(etat());

  faireEntrer(tickets[0]);
  faireEntrer(tickets[1]);
  scannerTicket(tickets[2].id, ETAPES_SCAN.ARRIVEE);

  const refus = scannerTicket(tickets[2].id, ETAPES_SCAN.ENTREE);
  assert.equal(refus.verdict, 'REFUSE');
  assert.match(refus.motif, /Salle pleine \(2\/2\)/);
  assert.equal(refus.placeConservee, true);
  assert.equal(etat().tickets[tickets[2].id].etat, ETATS_TICKET.EN_FILE_REELLE,
    'le visiteur garde sa place dans la file reelle');
});

test('RG-17 : des qu\'une sortie est comptee, le meme code fait entrer', async () => {
  journeeNeuve({ capaciteSalle: 1 });
  const [premier, second] = inscrire(2);
  ordonnancer(etat());
  faireEntrer(premier);
  scannerTicket(second.id, ETAPES_SCAN.ARRIVEE);

  assert.equal(scannerTicket(second.id, ETAPES_SCAN.ENTREE).verdict, 'REFUSE');

  // Le capteur voit le premier visiteur sortir. Le relevé n'est pris en compte
  // qu'au battement suivant : c'est exactement ce qui se passe en exploitation.
  forcerOccupation(0);
  await battement();
  assert.equal(scannerTicket(second.id, ETAPES_SCAN.ENTREE).verdict, 'ACCEPTE');
  assert.equal(etat().tickets[second.id].etat, ETATS_TICKET.ENTRE);
});

test('RG-17 : une rafale de scans ne remplit pas la salle au-dela de sa capacite', async () => {
  journeeNeuve({ capaciteSalle: 3 });
  const tickets = inscrire(6);
  ordonnancer(etat());
  for (const t of tickets) scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);

  // Six scans d'entree d'affilee, sans laisser le capteur se rafraichir : le
  // comptage corrige doit refuser les trois derniers.
  const verdicts = tickets.map((t) => scannerTicket(t.id, ETAPES_SCAN.ENTREE).verdict);
  assert.equal(verdicts.filter((v) => v === 'ACCEPTE').length, 3);
  assert.equal(verdicts.filter((v) => v === 'REFUSE').length, 3);
});

/* ======================================================================== */
/* RG-18 — Le QR code, deux usages puis plus rien                            */
/* ======================================================================== */

test('RG-18 : le meme code sert a l\'arrivee puis a l\'entree, et pas une fois de plus', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());

  assert.equal(scannerTicket(t.id).verdict, 'ARRIVEE');
  assert.equal(scannerTicket(t.id).verdict, 'ACCEPTE');

  const troisieme = scannerTicket(t.id);
  assert.equal(troisieme.verdict, 'REFUSE');
  assert.match(troisieme.motif, /déjà utilisé/);
});

test('RG-18 : l\'etape est deduite de l\'etat du ticket, et ne peut pas etre sautee', () => {
  journeeNeuve();
  const [t] = inscrire(1);
  ordonnancer(etat());

  const saut = scannerTicket(t.id, ETAPES_SCAN.ENTREE);
  assert.equal(saut.verdict, 'REFUSE');
  assert.match(saut.motif, /Arrivée non enregistrée/);

  scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);
  const doublon = scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);
  assert.equal(doublon.verdict, 'REFUSE');
  assert.match(doublon.motif, /déjà enregistrée/);
});

test('RG-18 : un code presente avant la convocation est refusé', () => {
  journeeNeuve();
  reglerHorloge({ heure: '08:30', vitesse: 0 });   // hors exploitation : pas de convocation
  const [t] = inscrire(1);
  const r = scannerTicket(t.id);
  assert.equal(r.verdict, 'REFUSE');
  assert.match(r.motif, /pas encore convoqué/);
});

/* ======================================================================== */
/* Le capteur : source unique de verite sur le remplissage                   */
/* ======================================================================== */

test('Capteur : sans URL, l\'occupation se deduit des entrees et de la duree de sejour', async () => {
  journeeNeuve({ dureeSejourMinSec: 30, dureeSejourMaxSec: 120 });
  const tickets = inscrire(4);
  ordonnancer(etat());
  for (const t of tickets) faireEntrer(t);

  await battement();
  assert.equal(dernierReleve().source, 'interne');
  assert.equal(dernierReleve().occupation, 4, 'les quatre sont encore dans la salle');

  avancer(3);    // au-dela de la duree de sejour maximale (2 min)
  await battement();
  assert.equal(dernierReleve().occupation, 0, 'la salle s\'est videe d\'elle-meme');
});

test('Capteur : une occupation forcee a 50 arrete les entrees, pas les convocations', async () => {
  journeeNeuve();
  const tickets = inscrire(40);
  ordonnancer(etat());
  scannerTicket(tickets[0].id, ETAPES_SCAN.ARRIVEE);

  forcerOccupation(50);
  await battement();
  const r = scannerTicket(tickets[0].id, ETAPES_SCAN.ENTREE);
  assert.equal(r.verdict, 'REFUSE');

  // La file reelle, elle, reste alimentee : c'est son plafond qui l'arrete.
  assert.equal(occupationFileReelle(etat()), 30);
  forcerOccupation(null);
});

test('Capteur : une URL injoignable ne bloque pas l\'exploitation', async () => {
  journeeNeuve({ capteurUrl: 'http://127.0.0.1:1/introuvable' });
  await releverCapteur(etat().regles.capteurUrl, 7);
  assert.equal(dernierReleve().source, 'interne');
  assert.equal(dernierReleve().occupation, 7);
  assert.ok(dernierReleve().erreur, 'la degradation est signalee au tableau de bord');
});

/* ======================================================================== */
/* Les vues ne confondent plus les trois etages                              */
/* ======================================================================== */

test('Vues : file virtuelle, file reelle et salle sont comptees separement', () => {
  journeeNeuve({ capaciteSalle: 50, capaciteFileReelle: 30 });
  const tickets = inscrire(45);
  ordonnancer(etat());
  for (const t of tickets.slice(0, 12)) scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);
  scannerTicket(tickets[0].id, ETAPES_SCAN.ENTREE);

  // 45 inscrits : 30 convoques, dont 12 arrives, dont 1 entre dans la salle.
  const v = vueFile(etat());
  assert.equal(v.salle.capacite, 50);
  assert.equal(v.salle.occupation, 1);
  assert.equal(v.fileReelle.capacite, 30);
  assert.equal(v.fileReelle.presents, 11);
  assert.equal(v.fileReelle.enRoute, 18);
  assert.equal(v.fileReelle.occupation, 29, 'presents + en route, une place liberee');
  assert.equal(v.compteurs.enAttente, 15);

  const zones = vueFileAgent(etat()).map((l) => l.zone);
  assert.equal(zones.filter((z) => z === 'FILE_REELLE').length, 11);
  assert.equal(zones.filter((z) => z === 'EN_ROUTE').length, 18);
  assert.equal(zones.filter((z) => z === 'VIRTUELLE').length, 15);
});

test('Vues : l\'attente annoncee se decompose en parc puis file reelle', () => {
  journeeNeuve();
  const tickets = inscrire(40);
  ordonnancer(etat());
  for (const t of tickets.slice(0, 30)) scannerTicket(t.id, ETAPES_SCAN.ARRIVEE);

  const dernier = etat().tickets[tickets[39].id];
  const vue = vueTicket(etat(), dernier);
  assert.ok(vue.estimation.minutesFileReelle > 0);
  assert.equal(
    vue.estimation.minutesVirtuelle + vue.estimation.minutesFileReelle,
    vue.estimation.minutes,
  );
  assert.equal(vue.devantReel, 30);
});

test('Vues : dans la file reelle, le visiteur voit sa position, plus un compte a rebours', () => {
  journeeNeuve({ capaciteSalle: 1 });
  const [premier, second] = inscrire(2);
  ordonnancer(etat());
  faireEntrer(premier);
  scannerTicket(second.id, ETAPES_SCAN.ARRIVEE);

  const vue = vueTicket(etat(), etat().tickets[second.id]);
  assert.equal(vue.etat, ETATS_TICKET.EN_FILE_REELLE);
  assert.equal(vue.positionFileReelle, 1);
  assert.equal(vue.resteSec, undefined, 'plus aucun compte a rebours une fois sur place');
  assert.equal(vue.salle.pleine, true);
});

/* ------------------------------------------------------------------------ */

test('Configuration : les valeurs par defaut decrivent bien 50 places et 30 en file', () => {
  assert.equal(REGLES_PAR_DEFAUT.capaciteSalle, 50);
  assert.equal(REGLES_PAR_DEFAUT.capaciteFileReelle, 30);
  assert.equal(REGLES_PAR_DEFAUT.dureeCycleMin, undefined, 'plus aucune notion de cycle');
  assert.equal(REGLES_PAR_DEFAUT.placesParCycle, undefined);
});