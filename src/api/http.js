/**
 * ---------------------------------------------------------------------------
 * MICRO-SERVEUR HTTP
 * ---------------------------------------------------------------------------
 * Une soixantaine de lignes de routage au-dessus du module `http` de Node.
 * C'est volontaire : aucun `npm install`, donc le projet demarre sur n'importe
 * quel poste avec la seule commande `node server.js`.
 *
 * Fournit : routage avec parametres (/tickets/:id), corps JSON, service des
 * fichiers statiques, et flux SSE pour le temps reel.
 * ---------------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ErreurMetier } from '../domain/commands.js';

const TYPES_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function creerApplication({ dossierStatique = 'public' } = {}) {
  const routes = [];

  /** Transforme "/tickets/:id" en expression reguliere + noms de parametres. */
  function compiler(chemin) {
    const noms = [];
    const motif = chemin
      .replace(/\/:([a-zA-Z0-9_]+)/g, (_, nom) => { noms.push(nom); return '/([^/]+)'; });
    return { regex: new RegExp(`^${motif}$`), noms };
  }

  function ajouter(methode, chemin, handler) {
    routes.push({ methode, ...compiler(chemin), handler });
  }

  const app = {
    get: (c, h) => ajouter('GET', c, h),
    post: (c, h) => ajouter('POST', c, h),
    put: (c, h) => ajouter('PUT', c, h),
    patch: (c, h) => ajouter('PATCH', c, h),
    delete: (c, h) => ajouter('DELETE', c, h),
  };

  const serveur = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chemin = url.pathname;

    for (const r of routes) {
      if (r.methode !== req.method) continue;
      const m = chemin.match(r.regex);
      if (!m) continue;

      const params = {};
      r.noms.forEach((nom, i) => { params[nom] = decodeURIComponent(m[i + 1]); });

      try {
        const body = await lireCorps(req);
        const ctx = { req, res, params, query: url.searchParams, body, url };
        const resultat = await r.handler(ctx);
        if (res.writableEnded) return;          // SSE ou reponse deja ecrite
        return json(res, 200, resultat ?? { ok: true });
      } catch (e) {
        if (e instanceof ErreurMetier) return json(res, 400, { erreur: e.message, code: e.code });
        if (e?.statut) return json(res, e.statut, { erreur: e.message });
        console.error('[http]', e);
        return json(res, 500, { erreur: 'Erreur interne' });
      }
    }

    // Une route d'API inconnue doit repondre 404, et surtout pas la page web :
    // c'est ce qui rend verifiable l'absence de route « ajouter un visiteur ».
    if (chemin.startsWith('/api/')) return json(res, 404, { erreur: 'Route inexistante' });

    return servirStatique(res, dossierStatique, chemin);
  });

  return { ...app, serveur, ecouter: (port) => serveur.listen(port) };
}

/** Reponse JSON. */
export function json(res, statut, corps) {
  const texte = JSON.stringify(corps);
  res.writeHead(statut, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(texte);
}

/** Erreur HTTP simple (401, 403, 404...). */
export function erreurHttp(statut, message) {
  const e = new Error(message);
  e.statut = statut;
  return e;
}

/** Ouvre un flux SSE et renvoie une fonction d'emission. */
export function ouvrirFlux(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': flux ouvert\n\n');
  return (donnees) => {
    if (res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(donnees)}\n\n`);
    return true;
  };
}

function lireCorps(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return Promise.resolve({});
  return new Promise((resoudre) => {
    let brut = '';
    req.on('data', (c) => { brut += c; if (brut.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resoudre(brut ? JSON.parse(brut) : {}); } catch { resoudre({}); }
    });
  });
}

function servirStatique(res, dossier, chemin) {
  // Application en page unique : toute route inconnue renvoie index.html.
  let fichier = path.join(dossier, chemin === '/' ? 'index.html' : chemin);
  if (!fichier.startsWith(path.resolve(dossier)) && !fichier.startsWith(dossier)) {
    return json(res, 403, { erreur: 'Accès refusé' });
  }
  if (!fs.existsSync(fichier) || fs.statSync(fichier).isDirectory()) {
    fichier = path.join(dossier, 'index.html');
  }
  if (!fs.existsSync(fichier)) return json(res, 404, { erreur: 'Introuvable' });

  res.writeHead(200, { 'Content-Type': TYPES_MIME[path.extname(fichier)] || 'text/plain' });
  fs.createReadStream(fichier).pipe(res);
}
