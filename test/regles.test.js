/**
 * ---------------------------------------------------------------------------
 * TESTS DES REGLES METIER
 * ---------------------------------------------------------------------------
 *   node --test test/
 *
 * « Les regles d'ordonnancement sont testees comme du code metier » (ch. 6).
 * Chaque test porte le numero de la regle du cahier des charges qu'il verifie.
 *
 * Les tests s'executent dans un dossier temporaire : ils n'ecrasent jamais le
 * journal de la demonstration.
 * ---------------------------------------------------------------------------
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation : on bascule dans un dossier temporaire AVANT de charger les
// modules, car le journal et l'horloge sont resolus relativement au dossier
// courant.
const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'waitless-test-'));
process.chdir(bac);
process.env.WAITLESS_SILENCIEUX = '1';   // pas de bruit de notifications

const base = new URL('../src/', import.meta.url);
const { chargerJournee, etat, effacerJournee } = await import(new URL('domain/eventStore.js', base));
const { reglerHorloge, maintenant } = await import(new URL('domain/clock.js', base));
const commandes = await import(new URL('domain/commands.js', base));
const { ordonnancer, resteGarantieMin } = await import(new URL('domain/scheduler.js', base));
const { ticketsEnAttente, ticketsConvoques, tempsActifEcoule } = await import(new URL('domain/state.js', base));
const { genererJeton, verifierJeton } = await import(new URL('domain/qr.js', base));
const { estimer } = await import(new URL('domain/estimator.js', base));

/** Remet le systeme a zero et positionne l'horloge en pleine exploitation. */
function repartirDeZero(heure = '10:00') {
  effacerJournee();
  chargerJournee();
  reglerHorloge({ heure, vitesse: 0 });   // vitesse 0 : le temps ne bouge pas
  return etat();
}

/** Inscrit un visiteur de bout en bout et renvoie son ticket. */
function inscrire(email, statut) {
  const { ecrireRegistre } = registre;
  ecrireRegistre({
    ...lireRegistreCourant(),
    [email]: { prenom: 'Test', initiale: 'T', statut, refBillet: 'BIL-TEST', anneeNaissance: null },
  });
  const v = commandes.enregistrerVisiteur(email);
  commandes.donnerConsentements(v.id, { cgu: true, decharge: true });
  commandes.declarerAptitude(v.id, true);
  return commandes.rejoindreFile(v.id);
}

const registre = await import(new URL('infra/billetterie.js', base));
function lireRegistreCourant() {
  try { return JSON.parse(fs.readFileSync(path.join('data', 'billetterie.json'), 'utf8')); }
  catch { return {}; }
}

/* ======================================================================== */

test('RG-03 — le rang d\'arrivee est strictement croissant et immuable', () => {
  const s = repartirDeZero();
  const a = inscrire('a@x.fr', 'HUMAIN');
  const b = inscrire('b@x.fr', 'HUMAIN');
  assert.equal(b.rang, a.rang + 1);

  // Meme apres un desistement en tete de file, les rangs ne bougent pas.
  commandes.seDesister(a.visiteurId);
  assert.equal(s.tickets[b.id].rang, b.rang);
});

test('RG-02 — un seul ticket actif par visiteur', () => {
  repartirDeZero();
  const t = inscrire('c@x.fr', 'HUMAIN');
  assert.throws(() => commandes.rejoindreFile(t.visiteurId), /déjà un ticket/i);
});

test('RG-02 — pas d\'inscription sans consentement ni aptitude', () => {
  repartirDeZero();
  const v = commandes.enregistrerVisiteur('d@x.fr');
  assert.throws(() => commandes.rejoindreFile(v.id), /consentement|décharge/i);
  commandes.donnerConsentements(v.id, { cgu: true, decharge: true });
  commandes.declarerAptitude(v.id, false);
  assert.throws(() => commandes.rejoindreFile(v.id), /conditions d'accès/i);
});

test('RG-06 — le Super Saiyan passe devant, dans la limite de son quota', () => {
  const s = repartirDeZero();
  for (let i = 0; i < 10; i++) inscrire(`h${i}@x.fr`, 'HUMAIN');
  const vip = inscrire('vip@x.fr', 'SUPER_SAIYAN');

  ordonnancer(s);
  const convoques = ticketsConvoques(s).map((t) => t.id);
  assert.ok(convoques.includes(vip.id), 'le Super Saiyan doit etre convoque immediatement');

  // Le quota de 15 % sur 20 places autorise au plus 3 Super Saiyans par cycle.
  const vips = [];
  for (let i = 0; i < 5; i++) vips.push(inscrire(`vip${i}@x.fr`, 'SUPER_SAIYAN'));
  ordonnancer(s);
  const convoquesVip = ticketsConvoques(s).filter((t) => t.statut === 'SUPER_SAIYAN').length;
  assert.ok(convoquesVip <= 3, `quota depasse : ${convoquesVip} Super Saiyans convoques`);
});

test('RG-08 — une part des places reste reservee aux Humains', () => {
  const s = repartirDeZero();
  for (let i = 0; i < 15; i++) inscrire(`sai${i}@x.fr`, 'SAIYAN');
  for (let i = 0; i < 15; i++) inscrire(`hum${i}@x.fr`, 'HUMAIN');

  ordonnancer(s);
  const humains = ticketsConvoques(s).filter((t) => t.statut === 'HUMAIN').length;
  assert.ok(humains >= 10, `famine de la file classique : seulement ${humains} Humains convoques`);
});

test('RG-07 — les inscriptions Saiyan ferment plutot que de promettre a tort', () => {
  const s = repartirDeZero();
  // On sature la file. A un moment, la garantie de 30 min devient intenable :
  // l'inscription suivante DOIT etre refusee. C'est le comportement voulu, pas
  // une erreur — on verifie donc que le refus arrive bien.
  let refusee = null;
  for (let i = 0; i < 200 && !refusee; i++) {
    try { inscrire(`foule${i}@x.fr`, 'SAIYAN'); }
    catch (e) { refusee = e; }
  }
  assert.ok(refusee, 'la file aurait du finir par refuser une inscription Saiyan');
  assert.match(refusee.message, /garantie/i);

  const etatSaiyan = commandes.etatInscriptions(s, 'SAIYAN');
  assert.equal(etatSaiyan.ouvert, false);

  // ...alors que la file classique, elle, reste ouverte.
  assert.equal(commandes.etatInscriptions(s, 'HUMAIN').ouvert, true);
});

test('RG-04 — les inscriptions ferment avant 19h00 en tenant compte de l\'attente', () => {
  const s = repartirDeZero('18:55');
  const etatHumain = commandes.etatInscriptions(s, 'HUMAIN');
  assert.equal(etatHumain.ouvert, false);
});

test('RG-01 — aucune convocation avant l\'heure d\'exploitation', () => {
  const s = repartirDeZero('08:30');
  inscrire('matin@x.fr', 'HUMAIN');
  const convoques = ordonnancer(s);
  assert.equal(convoques.length, 0, 'la file accepte les inscriptions mais ne convoque pas avant 9h');
  assert.equal(ticketsEnAttente(s).length, 1);
});

test('RG-12 — la pause gele les compteurs et les restitue a la reprise', () => {
  const s = repartirDeZero();
  const t = inscrire('pause@x.fr', 'HUMAIN');
  ordonnancer(s);

  const debut = maintenant();
  reglerHorloge({ heure: '10:02', vitesse: 0 });        // 2 minutes s'ecoulent
  commandes.mettreEnPause('Panne du sas', 'agent');
  reglerHorloge({ heure: '10:30', vitesse: 0 });        // 28 minutes de pause
  commandes.reprendre('agent');

  const ticket = s.tickets[t.id];
  const ecouleMin = tempsActifEcoule(s, ticket.convoqueA, maintenant()) / 60_000;
  assert.ok(ecouleMin < 3, `les 28 minutes de pause ne doivent pas etre comptees (${ecouleMin.toFixed(1)} min)`);
  assert.ok(maintenant() - debut > 25 * 60_000, 'le temps mur a bien avance');
});

test('RG-09 — le scan est accepte pendant la grace, refuse apres', () => {
  const s = repartirDeZero();
  const t = inscrire('scan@x.fr', 'HUMAIN');
  ordonnancer(s);

  const { jeton } = genererJeton(t.id, s.regles.validiteJetonQrSec);
  const ok = commandes.scanner(jeton, 'agent');
  assert.equal(ok.verdict, 'ACCEPTE');

  // Usage unique : le meme code ne passe pas deux fois.
  const { jeton: jeton2 } = genererJeton(t.id, s.regles.validiteJetonQrSec);
  assert.equal(commandes.scanner(jeton2, 'agent').verdict, 'REFUSE');
});

test('F-10 — un code capture reste inutilisable apres rotation', () => {
  const s = repartirDeZero();
  const t = inscrire('qr@x.fr', 'HUMAIN');
  ordonnancer(s);

  const { jeton } = genererJeton(t.id, 30);
  reglerHorloge({ heure: '10:05', vitesse: 0 });   // 5 minutes plus tard
  const verif = verifierJeton(jeton, 30);
  assert.equal(verif.valide, false);
  assert.match(verif.motif, /expiré/i);
});

test('RG-13 — apres un arret, le rejeu du journal rend exactement le meme etat', () => {
  const s = repartirDeZero();
  const tickets = [];
  for (let i = 0; i < 8; i++) tickets.push(inscrire(`reprise${i}@x.fr`, i % 4 === 0 ? 'SAIYAN' : 'HUMAIN'));
  ordonnancer(s);
  commandes.mettreEnPause('Test de reprise', 'agent');

  const avant = ticketsEnAttente(s).map((t) => `${t.id}:${t.rang}:${t.etat}`);
  const etatFileAvant = s.file.etat;

  // Simulation de la panne : on jette l'etat en memoire et on relit le journal.
  const apresEtat = chargerJournee();
  const apres = ticketsEnAttente(apresEtat).map((t) => `${t.id}:${t.rang}:${t.etat}`);

  assert.deepEqual(apres, avant, 'l\'ordre et les etats doivent etre identiques');
  assert.equal(apresEtat.file.etat, etatFileAvant, 'la pause doit survivre au redemarrage');
});

test('RG-11 — aucune route ne permet a un operateur de creer un ticket', async () => {
  const source = fs.readFileSync(new URL('api/routes.js', base), 'utf8');
  // La seule occurrence de rejoindreFile doit etre dans la route visiteur.
  const occurrences = source.split('rejoindreFile(').length - 1;
  assert.equal(occurrences, 1, 'rejoindreFile ne doit etre appelee qu\'a un seul endroit');

  const bloc = source.slice(source.indexOf('rejoindreFile(') - 400, source.indexOf('rejoindreFile(') + 40);
  assert.match(bloc, /exigerVisiteur/, 'la creation de ticket doit exiger le role visiteur');
  assert.doesNotMatch(source, /agent\/[^\n]*tickets'[^\n]*\n[^}]*rejoindreFile/, 'aucune route agent ne cree de ticket');
});

test('Estimation — la fourchette encadre la valeur et reste finie sous charge', () => {
  const s = repartirDeZero();
  for (let i = 0; i < 200; i++) inscrire(`charge${i}@x.fr`, 'HUMAIN');
  const e = estimer(s, 'HUMAIN');
  assert.ok(e.basse <= e.minutes && e.minutes <= e.haute);
  assert.ok(Number.isFinite(e.minutes) && e.minutes <= s.regles.attenteMaxAffichableMin);
});

test('RG-15 — une regle modifiee s\'applique immediatement', () => {
  const s = repartirDeZero();
  commandes.modifierRegles({ delaiConvocationSec: 300 }, 'admin');
  assert.equal(etat().regles.delaiConvocationSec, 300);
  // Et elle survit au redemarrage, puisqu'elle est journalisee.
  assert.equal(chargerJournee().regles.delaiConvocationSec, 300);
});

test('Garantie Saiyan — le reste diminue avec le temps actif', () => {
  const s = repartirDeZero();
  const t = inscrire('garantie@x.fr', 'SAIYAN');
  assert.equal(Math.round(resteGarantieMin(s, s.tickets[t.id])), 30);
  reglerHorloge({ heure: '10:10', vitesse: 0 });
  assert.equal(Math.round(resteGarantieMin(s, s.tickets[t.id])), 20);
});
