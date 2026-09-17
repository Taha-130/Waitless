/**
 * ---------------------------------------------------------------------------
 * HORLOGE D'EXPLOITATION
 * ---------------------------------------------------------------------------
 * Tout le domaine lit l'heure ICI et jamais via Date.now().
 *
 * Pourquoi : les regles metier sont datees (ouverture 8h, exploitation 9h-19h,
 * fermeture automatique des inscriptions...). Sans horloge pilotable, il serait
 * impossible de demontrer la fin de journee a 14h un jour de soutenance, ni de
 * tester l'ordonnanceur sans attendre 20 minutes par cycle.
 *
 * L'horloge accepte deux reglages :
 *   - heure  : positionne l'heure simulee (ex. "18:45")
 *   - vitesse: facteur d'acceleration (1 = temps reel, 60 = 1 min par seconde)
 *
 * Le reglage est persiste : un redemarrage ne fait pas sauter la demonstration.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

const FICHIER = path.join('data', 'horloge.json');

// Ancre : a l'instant reel `reel`, l'heure simulee valait `simule`.
let ancre = { reel: Date.now(), simule: Date.now(), vitesse: 1 };

charger();

/** Heure simulee courante, en millisecondes epoch. */
export function maintenant() {
  return Math.round(ancre.simule + (Date.now() - ancre.reel) * ancre.vitesse);
}

/** Minutes ecoulees depuis minuit (heure locale) pour l'heure simulee. */
export function minutesDuJour(ms = maintenant()) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** Journee d'exploitation au format AAAA-MM-JJ. Sert de cle de journal et de QR. */
export function jourExploitation(ms = maintenant()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Formate une heure simulee en HH:MM. */
export function formatHeure(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Convertit « minutes depuis minuit » en timestamp du jour simule. */
export function timestampDuJour(minutes, ms = maintenant()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + minutes * 60_000;
}

/** Etat courant de l'horloge, pour l'ecran d'administration. */
export function etatHorloge() {
  return {
    maintenant: maintenant(),
    heure: formatHeure(maintenant()),
    jour: jourExploitation(),
    vitesse: ancre.vitesse,
    tempsReel: ancre.vitesse === 1 && Math.abs(maintenant() - Date.now()) < 60_000,
  };
}

/**
 * Regle l'horloge.
 * @param {{heure?: string, vitesse?: number, reel?: boolean}} reglage
 */
export function reglerHorloge({ heure, vitesse, reel } = {}) {
  if (reel) {
    ancre = { reel: Date.now(), simule: Date.now(), vitesse: 1 };
    sauvegarder();
    return etatHorloge();
  }

  let simule = maintenant();
  if (heure) {
    const [h, m] = String(heure).split(':').map(Number);
    const d = new Date(simule);
    d.setHours(h || 0, m || 0, 0, 0);
    simule = d.getTime();
  }
  const v = vitesse === undefined ? ancre.vitesse : Math.min(600, Math.max(0, Number(vitesse) || 0));
  ancre = { reel: Date.now(), simule, vitesse: v };
  sauvegarder();
  return etatHorloge();
}

function sauvegarder() {
  try {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(FICHIER, JSON.stringify(ancre));
  } catch {
    /* l'horloge reste en memoire si le disque refuse : ce n'est pas bloquant */
  }
}

function charger() {
  try {
    const brut = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
    if (typeof brut?.simule === 'number') {
      // On rejoue le temps ecoule pendant l'arret, a la vitesse configuree.
      ancre = {
        reel: Date.now(),
        simule: brut.simule + (Date.now() - brut.reel) * (brut.vitesse ?? 1),
        vitesse: brut.vitesse ?? 1,
      };
    }
  } catch {
    /* premier demarrage : on reste sur l'heure reelle */
  }
}
