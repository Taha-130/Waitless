/**
 * ---------------------------------------------------------------------------
 * REFERENTIEL BILLETTERIE
 * ---------------------------------------------------------------------------
 * Hypothese du cahier des charges : « Statuts attribues a la billetterie et
 * importes dans Waitless ; l'application ne vend pas de statut ».
 *
 * Waitless ne cree donc jamais un statut : il le LIT. Ordre de consultation :
 *
 *   1. la base de la billetterie, par GET sur l'URL configuree (regle
 *      `billetterieUrl`, valeur par defaut dans src/config/urls.js) ;
 *   2. a defaut (URL vide, injoignable, ou e-mail absent de la base), le
 *      fichier data/billetterie.json (alimente par seed.js) ;
 *   3. a defaut, un billet fabrique de facon deterministe, coherent avec la
 *      repartition annoncee (80 % Humains, 15 % Saiyans, 5 % Super Saiyans) :
 *      le meme e-mail donnera toujours le meme statut, ce qui rend les
 *      demonstrations reproductibles.
 *
 * Le GET est asynchrone, la recherche d'un billet ne l'est pas : on telecharge
 * la base dans un cache memoire (`chargerBilletterie`) juste avant d'en avoir
 * besoin, puis `chercherBillet` lit ce cache. Le domaine reste synchrone.
 *
 * Formats de reponse acceptes (JSON) :
 *   - un objet indexe par e-mail, comme data/billetterie.json :
 *       { "lea@exemple.fr": { "prenom": "Lea", "statut": "SAIYAN", ... }, ... }
 *   - un tableau de visiteurs :
 *       [ { "email": "lea@exemple.fr", "prenom": "Lea", "statut": "SAIYAN" }, ... ]
 *   - ce meme tableau enveloppe : { "visiteurs": [...] }, { "users": [...] }
 *     ou { "data": [...] }.
 *
 * Seuls les champs utiles sont conserves (prenom, initiale, statut, reference
 * du billet, annee de naissance) : un nom de famille ou une adresse presents
 * dans la base ne sont jamais recopies dans le journal (chapitre 7).
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FICHIER = path.join('data', 'billetterie.json');
const DELAI_MAX_MS = 2000;
const STATUTS = ['HUMAIN', 'SAIYAN', 'SUPER_SAIYAN'];

/** Derniere copie de la base distante, et l'issue du dernier appel. */
let distant = { url: '', registre: {}, nombre: 0, ts: 0, erreur: null };

/* ------------------------------------------------------------------------ */
/* 1. Base distante (GET)                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Telecharge la base de la billetterie et la garde en memoire.
 * Ne leve jamais : une billetterie injoignable ne doit pas empecher un
 * visiteur de se connecter. En cas d'echec, la derniere copie reussie reste
 * utilisable, puis viennent les replis locaux.
 *
 * @param {string} url  URL de la base (vide = pas d'appel)
 * @returns {Promise<object>} etat du cache, voir `etatBilletterie()`
 */
export async function chargerBilletterie(url) {
  if (!url) return etatBilletterie();

  try {
    const reponse = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DELAI_MAX_MS),
    });
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const registre = normaliserBase(await reponse.json());
    distant = { url, registre, nombre: Object.keys(registre).length, ts: Date.now(), erreur: null };
  } catch (e) {
    // On garde la copie precedente si elle vient de la meme URL.
    if (distant.url !== url) distant = { url, registre: {}, nombre: 0, ts: 0, erreur: null };
    distant.erreur = String(e.message || e);
    console.warn(`[billetterie] ${url} injoignable (${distant.erreur}) : repli local.`);
  }
  return etatBilletterie();
}

/** Etat du dernier chargement, pour le diagnostic. */
export function etatBilletterie() {
  const { url, nombre, ts, erreur } = distant;
  return { url, nombre, ts, erreur };
}

/** Vide le cache distant (utile aux tests). */
export function reinitialiserBilletterie() {
  distant = { url: '', registre: {}, nombre: 0, ts: 0, erreur: null };
}

/** Transforme la reponse de la billetterie en { email: billet }. */
function normaliserBase(donnees) {
  let entrees;
  if (Array.isArray(donnees)) {
    entrees = donnees.map((d) => [d?.email, d]);
  } else if (donnees && typeof donnees === 'object') {
    const liste = donnees.visiteurs ?? donnees.users ?? donnees.data;
    entrees = Array.isArray(liste)
      ? liste.map((d) => [d?.email, d])
      : Object.entries(donnees);
  } else {
    throw new Error('format de reponse non reconnu');
  }

  const registre = {};
  for (const [email, brut] of entrees) {
    if (!email || !brut || typeof brut !== 'object') continue;
    registre[String(email).trim().toLowerCase()] = normaliserBillet(brut);
  }
  return registre;
}

/** Ne garde que les champs utiles, sous la forme attendue par le domaine. */
function normaliserBillet(b) {
  const prenom = String(b.prenom ?? b.firstName ?? b.firstname ?? 'Visiteur');
  const statutBrut = String(b.statut ?? b.status ?? 'HUMAIN').trim().toUpperCase().replace(/[\s-]+/g, '_');
  // Un statut inconnu ne donne aucun privilege.
  const statut = STATUTS.includes(statutBrut) ? statutBrut : 'HUMAIN';
  const annee = Number(b.anneeNaissance ?? b.birthYear);
  return {
    prenom,
    initiale: String(b.initiale ?? prenom.charAt(0)),
    statut,
    refBillet: String(b.refBillet ?? b.ref ?? b.billet ?? b.ticket ?? ''),
    anneeNaissance: Number.isFinite(annee) && annee > 0 ? annee : null,
  };
}

/* ------------------------------------------------------------------------ */
/* 2. Fichier local                                                          */
/* ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ */
/* 3. Billet deduit de l'e-mail                                              */
/* ------------------------------------------------------------------------ */

/** Entier stable dans [0, 100[ derive de l'e-mail. */
function empreinte(email) {
  const h = createHash('sha256').update(email.toLowerCase()).digest();
  return h[0] % 100;
}

/**
 * Retourne le billet associe a un e-mail.
 * Pour que la base distante soit consultee, appeler `chargerBilletterie(url)`
 * juste avant.
 * @returns {{prenom:string, initiale:string, statut:string, refBillet:string, anneeNaissance:number|null}}
 */
export function chercherBillet(email) {
  const cle = email.toLowerCase();

  const distantConnu = distant.registre[cle];
  if (distantConnu) return distantConnu;

  const localConnu = lireRegistre()[cle];
  if (localConnu) return localConnu;

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
