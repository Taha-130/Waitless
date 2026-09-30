/**
 * ---------------------------------------------------------------------------
 * ROUTES DE L'API
 * ---------------------------------------------------------------------------
 * Correspond au tableau « Points d'entree de l'API » du chapitre 6.
 *
 * A noter, et c'est volontairement verifiable : il n'existe nulle part de route
 * permettant a un agent ou a un administrateur de CREER un ticket. La seule
 * creation possible est POST /api/queues/:id/tickets, protegee par le role
 * « visiteur ». C'est la traduction technique de RG-11.
 * ---------------------------------------------------------------------------
 */

import { etat, publier } from '../domain/eventStore.js';
import { reglerHorloge, etatHorloge, maintenant } from '../domain/clock.js';
import {
  ticketActifDe, dernierTicketDe, occupationSalleEstimee, ETATS_TICKET,
} from '../domain/state.js';
import { genererJeton } from '../domain/qr.js';
import { ordonnancer } from '../domain/scheduler.js';
import { validerRegles } from '../config/rules.js';
import {
  ErreurMetier, TEXTES,
  enregistrerVisiteur, donnerConsentements, declarerAptitude,
  rejoindreFile, seDesister, retirerTicket,
  mettreEnPause, reprendre, purger, rouvrirFile,
  ouvrirIncident, cloreIncident, scanner, modifierRegles, modifierVisiteur,
} from '../domain/commands.js';
import { envoyer, messages } from '../infra/mailer.js';
import { dernierReleve, forcerOccupation, releverCapteur } from '../infra/sensor.js';
import { semer } from '../infra/jeuDeDonnees.js';
import { erreurHttp, ouvrirFlux } from './http.js';
import {
  creerLienMagique, verifierLienMagique, creerSession,
  exigerRole, exigerVisiteur,
} from './auth.js';
import { vueFile, vueTicket, vueFileAgent, vueMetriques, vueUtilisateurs } from './views.js';

/** Flux SSE ouverts. */
const flux = new Set();

/** Pousse l'etat courant a tous les clients connectes (F-05). */
export function diffuserEtat() {
  if (flux.size === 0) return;
  const charge = vueFile(etat());
  for (const emettre of [...flux]) {
    if (!emettre(charge)) flux.delete(emettre);
  }
}

export function enregistrerRoutes(app) {
  /* ==================================================================== */
  /* Authentification                                                     */
  /* ==================================================================== */

  // F-01 : connexion par lien e-mail, sans mot de passe.
  app.post('/api/auth/magic-link', ({ body }) => {
    const visiteur = enregistrerVisiteur(body.email);
    const jeton = creerLienMagique(visiteur.email);
    const lien = `/?connexion=${encodeURIComponent(jeton)}`;
    envoyer(visiteur.email, 'Votre lien de connexion Waitless',
      `Cliquez pour ouvrir votre file d'attente : ${lien}`, 'LIEN');
    // Le lien est aussi renvoye ici : sans SMTP, c'est ce qui rend la
    // demonstration possible. En production, on ne renverrait que { ok: true }.
    return { ok: true, lien, jeton };
  });

  app.post('/api/auth/verify', ({ body }) => {
    const email = verifierLienMagique(body.jeton);
    if (!email) throw erreurHttp(401, 'Lien invalide ou expiré');
    const visiteur = enregistrerVisiteur(email);
    return { session: creerSession('visiteur', visiteur.id), visiteur: profil(visiteur) };
  });

  app.post('/api/auth/backoffice/login', ({ body }) => {
    const r = etat().regles;
    const code = String(body.code || '');
    if (code === r.codeAdmin) return { session: creerSession('admin', 'admin'), role: 'admin' };
    if (code === r.codeAgent) return { session: creerSession('agent', 'agent'), role: 'agent' };
    throw erreurHttp(401, 'Code invalide');
  });

  /* ==================================================================== */
  /* Profil, consentements, droits RGPD                                   */
  /* ==================================================================== */

  app.get('/api/me', (ctx) => {
    const v = exigerVisiteur(ctx);
    // Le dernier ticket, actif ou termine : le visiteur a droit a la confirmation
    // de son entree, ou a l'explication de son expiration.
    const t = dernierTicketDe(etat(), v.id);
    return { visiteur: profil(v), ticket: vueTicket(etat(), t), textes: TEXTES };
  });

  app.post('/api/me/consents', (ctx) => {
    const v = exigerVisiteur(ctx);
    return { visiteur: profil(donnerConsentements(v.id, ctx.body)) };
  });

  // F-02 : le front n'envoie qu'un booleen, jamais une reponse de sante.
  app.post('/api/me/eligibility', (ctx) => {
    const v = exigerVisiteur(ctx);
    return { visiteur: profil(declarerAptitude(v.id, ctx.body.apte)) };
  });

  app.get('/api/me/messages', (ctx) => {
    const v = exigerVisiteur(ctx);
    return { messages: messages(v.email) };
  });

  // Droit d'acces et de portabilite : tout ce que le systeme sait de moi.
  app.get('/api/me/export', (ctx) => {
    const v = exigerVisiteur(ctx);
    const s = etat();
    return {
      visiteur: v,
      tickets: Object.values(s.tickets).filter((t) => t.visiteurId === v.id),
      genereLe: new Date(maintenant()).toISOString(),
    };
  });

  // Droit a l'effacement.
  app.delete('/api/me', (ctx) => {
    const v = exigerVisiteur(ctx);
    const t = ticketActifDe(etat(), v.id);
    if (t) publier('TICKET_ANNULE', { ticketId: t.id, motif: 'Effacement du compte' });
    publier('VISITEUR_EFFACE', { visiteurId: v.id });
    return { ok: true, message: 'Vos données nominatives ont été effacées.' };
  });

  /* ==================================================================== */
  /* File : consultation et temps reel                                    */
  /* ==================================================================== */

  app.get('/api/queues/:id', () => vueFile(etat()));

  app.get('/api/queues/:id/wait-times', () => vueFile(etat()).attente);

  // F-05 : flux serveur -> client, mis a jour a chaque battement.
  app.get('/api/queues/:id/stream', (ctx) => {
    const emettre = ouvrirFlux(ctx.res);
    flux.add(emettre);
    emettre(vueFile(etat()));
    ctx.req.on('close', () => flux.delete(emettre));
  });

  /* ==================================================================== */
  /* Tickets — SEULE voie d'entree dans la file                           */
  /* ==================================================================== */

  app.post('/api/queues/:id/tickets', (ctx) => {
    const v = exigerVisiteur(ctx);            // jamais un agent, jamais un admin
    const ticket = rejoindreFile(v.id);
    ordonnancer(etat());                      // RG-06 : Super Saiyan convoque aussitot
    diffuserEtat();
    return { ticket: vueTicket(etat(), etat().tickets[ticket.id]) };
  });

  app.get('/api/tickets/:id', (ctx) => {
    const v = exigerVisiteur(ctx);
    const t = etat().tickets[ctx.params.id];
    if (!t || t.visiteurId !== v.id) throw erreurHttp(404, 'Ticket introuvable');
    return { ticket: vueTicket(etat(), t) };
  });

  // RG-14 : desistement, definitif.
  app.delete('/api/tickets/:id', (ctx) => {
    const v = exigerVisiteur(ctx);
    const t = etat().tickets[ctx.params.id];
    if (!t || t.visiteurId !== v.id) throw erreurHttp(404, 'Ticket introuvable');
    const annule = seDesister(v.id);
    ordonnancer(etat());
    diffuserEtat();
    return { ticket: vueTicket(etat(), annule) };
  });

  // F-10 : le jeton n'est delivre qu'a un ticket convoque, et il tourne.
  app.get('/api/tickets/:id/qr', (ctx) => {
    const v = exigerVisiteur(ctx);
    const t = etat().tickets[ctx.params.id];
    if (!t || t.visiteurId !== v.id) throw erreurHttp(404, 'Ticket introuvable');
    // Le code s'active a la convocation et sert une seule fois, au scan a
    // l'entree de la file reelle.
    if (t.etat !== ETATS_TICKET.CONVOQUE) {
      throw new ErreurMetier('Le code n\'est actif qu\'une fois convoqué', 'NON_CONVOQUE');
    }
    return genererJeton(t.id, etat().regles.validiteJetonQrSec);
  });

  /* ==================================================================== */
  /* Console agent                                                        */
  /* ==================================================================== */

  /**
   * Scan du QR code, a l'entree de la file reelle. C'est le seul scan du
   * parcours : l'entree dans la salle se fait ensuite sans verification.
   */
  app.post('/api/agent/scans', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const resultat = scanner(ctx.body.jeton, s.role);
    ordonnancer(etat());
    diffuserEtat();
    return resultat;
  });

  app.get('/api/agent/queue', (ctx) => {
    exigerRole(ctx, 'agent', 'admin');
    return { file: vueFileAgent(etat()), vue: vueFile(etat()) };
  });

  app.delete('/api/agent/tickets/:id', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const t = retirerTicket(ctx.params.id, ctx.query.get('motif'), s.role);
    ordonnancer(etat());
    diffuserEtat();
    return { ticket: vueTicket(etat(), t) };
  });

  app.post('/api/agent/queues/:id/pause', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const file = mettreEnPause(ctx.body.motif, s.role);
    diffuserEtat();
    return { file };
  });

  app.post('/api/agent/queues/:id/resume', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const file = reprendre(s.role);
    ordonnancer(etat());
    diffuserEtat();
    return { file };
  });

  app.post('/api/agent/queues/:id/purge', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    if (ctx.body.confirmation !== 'PURGER') {
      throw new ErreurMetier('Double confirmation requise', 'CONFIRMATION_MANQUANTE');
    }
    const resultat = purger(ctx.body.motif, s.role);
    diffuserEtat();
    return resultat;
  });

  app.post('/api/agent/queues/:id/reopen', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const file = rouvrirFile(s.role);
    diffuserEtat();
    return { file };
  });

  app.post('/api/agent/incidents', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    const incident = ouvrirIncident(ctx.body.type || 'TECHNIQUE', ctx.body.motif, s.role);
    diffuserEtat();
    return { incident };
  });

  app.post('/api/agent/incidents/:id/close', (ctx) => {
    const s = exigerRole(ctx, 'agent', 'admin');
    return { incident: cloreIncident(ctx.params.id, s.role) };
  });

  app.get('/api/agent/incidents', (ctx) => {
    exigerRole(ctx, 'agent', 'admin');
    return { incidents: etat().incidents, scans: etat().scans.slice(-30).reverse() };
  });

  /* ==================================================================== */
  /* Capteur de la Salle du Temps (F-14)                                  */
  /* ==================================================================== */

  // Le capteur compte les personnes PRESENTES DANS LA SALLE. C'est la seule
  // mesure que le systeme ne peut pas deduire : personne ne scanne en sortant.
  app.get('/api/sensors/time-chamber/:id', () => dernierReleve());
  // Ancien chemin, conserve le temps que les capteurs deployes soient reconfigures.
  app.get('/api/sensors/waiting-room/:id', () => dernierReleve());

  // Permet de jouer la saturation de la salle pendant la demonstration.
  app.put('/api/mock/sensors', async (ctx) => {
    exigerRole(ctx, 'admin');
    const valeur = forcerOccupation(ctx.body.occupation);
    // Releve immediat, sans attendre le battement suivant. C'est surtout vrai
    // au RELACHEMENT du forcage : sans cela, l'ecran continuerait d'afficher
    // une salle pleine pendant cinq secondes apres qu'on l'a liberee.
    await releverCapteur(etat().regles.capteurUrl, occupationSalleEstimee(etat(), maintenant()));
    diffuserEtat();
    return { forcage: valeur, releve: dernierReleve() };
  });

  /* ==================================================================== */
  /* Tableau de bord administrateur                                       */
  /* ==================================================================== */

  app.get('/api/admin/metrics', (ctx) => {
    exigerRole(ctx, 'admin');
    return vueMetriques(etat());
  });

  app.get('/api/admin/config/rules', (ctx) => {
    exigerRole(ctx, 'admin');
    return { regles: etat().regles };
  });

  // F-16 / RG-15 : modification a chaud, sans redeploiement.
  app.put('/api/admin/config/rules', (ctx) => {
    const s = exigerRole(ctx, 'admin');
    const { ok, erreurs, valeurs } = validerRegles(ctx.body);
    if (!ok) throw new ErreurMetier(erreurs.join(' ; '), 'REGLES_INVALIDES');
    const regles = modifierRegles(valeurs, s.role);
    diffuserEtat();
    return { regles };
  });

  // Onglet « Utilisateurs » : consultation et correction des visiteurs.
  app.get('/api/admin/users', (ctx) => {
    exigerRole(ctx, 'admin');
    return { utilisateurs: vueUtilisateurs(etat()) };
  });

  app.put('/api/admin/users/:id', (ctx) => {
    const s = exigerRole(ctx, 'admin');
    if (!etat().visiteurs[ctx.params.id] || etat().visiteurs[ctx.params.id].efface) {
      throw erreurHttp(404, 'Utilisateur introuvable');
    }
    const { prenom, initiale, statut, apte } = ctx.body;
    modifierVisiteur(ctx.params.id, { prenom, initiale, statut, apte }, s.role);
    diffuserEtat();
    return { utilisateurs: vueUtilisateurs(etat()) };
  });

  app.get('/api/admin/audit-logs', (ctx) => {
    exigerRole(ctx, 'admin');
    return { audit: etat().audit.slice(-200).reverse() };
  });

  app.get('/api/admin/mailbox', (ctx) => {
    exigerRole(ctx, 'admin');
    return { messages: messages() };
  });

  // Horloge de demonstration : indispensable pour montrer 8h, 19h, un cycle...
  app.get('/api/admin/clock', (ctx) => { exigerRole(ctx, 'admin'); return etatHorloge(); });

  app.post('/api/admin/clock', (ctx) => {
    exigerRole(ctx, 'admin');
    const h = reglerHorloge(ctx.body);
    diffuserEtat();
    return h;
  });

  // Peuplement du jeu de donnees fictif, sans arreter le serveur.
  app.post('/api/admin/seed', (ctx) => {
    exigerRole(ctx, 'admin');
    const resultat = semer(Number(ctx.body.nombre) || 24, {
      scannes: Number(ctx.body.scannes) || 0,
    });
    diffuserEtat();
    return resultat;
  });

  /* ==================================================================== */
  /* Sante du service                                                     */
  /* ==================================================================== */

  app.get('/api/health', () => ({
    ok: true,
    jour: etat().jour,
    evenements: etat().dernierSeq,
    horloge: etatHorloge(),
  }));
}

/** Projection publique d'un visiteur : on n'expose jamais l'etat brut. */
function profil(v) {
  return {
    id: v.id,
    email: v.email,
    prenom: v.prenom,
    initiale: v.initiale,
    statut: v.statut,
    refBillet: v.refBillet,
    apte: v.apte,
    consentements: v.consentements.map((c) => ({ type: c.type, version: c.version })),
  };
}
