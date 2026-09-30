/* ==========================================================================
   WAITLESS — application front (page unique, sans framework)
   --------------------------------------------------------------------------
   Trois interfaces dans un seul fichier, choisies selon le role de la session :
     - visiteur : s'inscrire, suivre son attente, presenter son code
     - agent    : scanner, gerer la file, declarer les incidents
     - admin    : piloter, regler, auditer

   Le front ne contient AUCUNE regle metier. Il affiche ce que le serveur
   calcule et envoie des intentions. C'est ce qui garantit qu'un visiteur
   malin ne peut pas contourner une regle depuis sa console.
   ========================================================================== */

const FILE = 'salle-du-temps';

/* ---------------------------------------------------------------- Etat --- */

const S = {
  session: localStorage.getItem('waitless.session') || null,
  role: localStorage.getItem('waitless.role') || null,
  vue: null,        // vue publique de la file (poussee par SSE)
  moi: null,        // visiteur + son ticket
  agent: null,      // file detaillee
  admin: null,      // metriques, regles, audit
  onglet: 'attente',
  message: null,    // {type, texte}
  scan: null,       // dernier verdict
  modal: null,      // popup de confirmation en cours : {titre, texte, action, texteConfirmer}
  recuA: 0,         // horodatage local de la derniere reception (compte a rebours)
};

/* ------------------------------------------------------------ Utilitaires */

const $ = (sel) => document.querySelector(sel);

function echapper(t) {
  return String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 30 -> « 30 s », 120 -> « 2 min », 75 -> « 1 min 15 s ». */
function formaterDuree(sec) {
  const total = Math.round(Number(sec) || 0);
  const m = Math.floor(total / 60), s = total % 60;
  if (!m) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

async function api(methode, chemin, corps) {
  const reponse = await fetch(chemin, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      ...(S.session ? { Authorization: `Bearer ${S.session}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) throw new Error(donnees.erreur || `Erreur ${reponse.status}`);
  return donnees;
}

function annoncer(texte, type = 'info') {
  S.message = texte ? { texte, type } : null;
  rendre();
}

/** Enveloppe les actions : affiche l'erreur metier telle que le serveur la formule. */
async function agir(action, succes) {
  try {
    const r = await action();
    await rafraichir();
    annoncer(succes || null, 'succes');
    return r;
  } catch (e) {
    annoncer(e.message, 'erreur');
  }
}

function seDeconnecter() {
  localStorage.removeItem('waitless.session');
  localStorage.removeItem('waitless.role');
  S.session = null; S.role = null; S.moi = null; S.agent = null; S.admin = null;
  rendre();
}

function ouvrirSession(jeton, role) {
  S.session = jeton; S.role = role;
  localStorage.setItem('waitless.session', jeton);
  localStorage.setItem('waitless.role', role);
}


function ouvrirModal(titre, texte, action, texteConfirmer = 'Confirmer') {
  S.modal = { titre, texte, action, texteConfirmer };
  rendre();
}

function fermerModal() {
  S.modal = null;
  rendre();
}

/* -------------------------------------------------------------------------
   CORRECTION : blocModal etait definie par erreur A L'INTERIEUR de
   ecranAttraction(). Elle est ici remontee au niveau global, sinon rendre()
   leve « ReferenceError: blocModal is not defined » des qu'une confirmation
   s'ouvre, ce qui interrompt le rendu AVANT brancherActions() : plus aucun
   bouton n'etait alors rattache a son action (boutons inertes).
   ---------------------------------------------------------------------- */
function blocModal() {
  const m = S.modal;
  if (!m) return '';
  return `<div class="modal-fond">
    <div class="modal-boite">
      <h3>${echapper(m.titre)}</h3>
      <p>${echapper(m.texte)}</p>
      <div class="ligne">
        <button class="sobre" data-action="fermer-modal">Annuler</button>
        <button class="danger" data-action="confirmer-modal">${echapper(m.texteConfirmer)}</button>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------- Chargement des donnees */

async function rafraichir() {
  try {
    if (S.role === 'visiteur') S.moi = await api('GET', '/api/me');
    if (S.role === 'agent' || S.role === 'admin') S.agent = await api('GET', '/api/agent/queue');
    if (S.role === 'admin') {
      const [metriques, regles, audit, utilisateurs] = await Promise.all([
        api('GET', '/api/admin/metrics'),
        api('GET', '/api/admin/config/rules'),
        api('GET', '/api/admin/audit-logs'),
        api('GET', '/api/admin/users'),
      ]);
      S.admin = {
        metriques, regles: regles.regles, audit: audit.audit, utilisateurs: utilisateurs.utilisateurs,
      };
    }
    S.recuA = Date.now();
  } catch (e) {
    if (/401|Session|Authentification/i.test(e.message)) seDeconnecter();
  }
  rendre();
}
function saisieOuConsentementEnCours() {
  return (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    || !!document.getElementById('cgu')
    || !!document.getElementById('decharge')
  );
}
/** Flux temps reel : le serveur pousse l'etat de la file a chaque battement. */
function ouvrirFlux() {
  const source = new EventSource(`/api/queues/${FILE}/stream`);

  source.onmessage = (ev) => {
    S.vue = JSON.parse(ev.data);

    const saisieEnCours = saisieOuConsentementEnCours();

    if (S.session) rafraichirDiscret(saisieEnCours);
    else if (!saisieEnCours && !S.modal) rendre();
    else rendreBandeau();
  };

  source.onerror = () => rendreBandeau();
}

async function rafraichirDiscret(saisieEnCours) {
  try {
    if (S.role === 'visiteur') S.moi = await api('GET', '/api/me');
    if (S.role === 'agent' || S.role === 'admin') S.agent = await api('GET', '/api/agent/queue');
    if (S.role === 'admin' && S.onglet !== 'regles') {
      S.admin = {
        ...S.admin,
        metriques: await api('GET', '/api/admin/metrics'),
        audit: (await api('GET', '/api/admin/audit-logs')).audit,
      };
    }
    S.recuA = Date.now();
  } catch { /* le bandeau signalera la coupure */ }
  // L'onglet Utilisateur n'est pas redessine a chaque battement : cela
  // effacerait une modification en cours avant qu'elle soit enregistree.
  const edition = S.role === 'admin' && S.onglet === 'utilisateurs';
  if (saisieEnCours || edition || S.modal) rendreBandeau(); else rendre();
}

/* ------------------------------------------------------------ Rendu ----- */

function rendre() {
  rendreBandeau();

  const app = $('#app');
  app.className = S.role === 'agent' || S.role === 'admin' ? 'large' : '';

  let html = S.message
    ? `<div class="message ${S.message.type}">${echapper(S.message.texte)}</div>`
    : '';

  if (!S.session) html += ecranConnexion();
  else if (S.role === 'visiteur') html += ecranVisiteur();
  else if (S.role === 'agent') html += ecranAgent();
  else if (S.role === 'admin') html += ecranAdmin();

  if (S.modal) html += blocModal();

  app.innerHTML = html;
  
  brancherActions(app);
  dessinerQr();
}

function rendreBandeau() {
  const v = S.vue;
  const etats = { OUVERTE: '', EN_PAUSE: 'pause', PURGEE: 'alerte' };
  // Les compteurs de la salle et de la file reelle sont des donnees
  // d'exploitation : on ne les affiche qu'a l'equipe, pas aux visiteurs.
  const equipe = S.role === 'agent' || S.role === 'admin';
  $('#bandeau').innerHTML = `
    <span class="horloge">${v ? v.horloge.heure : '--:--'}</span>
    ${v && v.horloge.vitesse !== 1 ? `<span class="pastille">x${v.horloge.vitesse}</span>` : ''}
    <span>${v ? echapper(v.file.nom) : 'Waitless'}</span>
    ${v ? `<span class="pastille ${etats[v.file.etat] || ''}">${libelleEtatFile(v)}</span>` : ''}
    ${v && equipe ? `<span class="pastille ${v.salle.pleine ? 'alerte' : ''}">Salle ${v.salle.occupation}/${v.salle.capacite}</span>` : ''}
    ${v && equipe ? `<span class="pastille ${v.fileReelle.pleine ? 'alerte' : ''}">File réelle ≈ ${v.fileReelle.occupation}/${v.fileReelle.capacite}</span>` : ''}
    <span class="pousse">${S.role ? `<button data-action="deconnexion">Quitter (${S.role})</button>` : ''}</span>
  `;
  // Le bandeau est parfois redessine seul (pendant une saisie) : il rebranche
  // donc lui-meme ses boutons, sinon « Quitter » deviendrait inerte.
  $('#bandeau').querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => executer(el.dataset.action, el.dataset));
  });
}

function libelleEtatFile(v) {
  if (v.file.etat === 'EN_PAUSE') return `En pause — ${v.file.motifPause}`;
  if (v.file.etat === 'PURGEE') return 'Fermée';
  return v.file.enExploitation ? 'En exploitation' : 'Hors exploitation';
}

/* ===================================================== ECRAN CONNEXION === */

function ecranConnexion() {
  return `
    <div class="bloc">
      <h1>La Salle du Temps, sans la queue</h1>
      <p class="discret">Inscrivez-vous depuis votre téléphone, profitez du parc,
      et revenez quand nous vous appelons.</p>
      <label for="email">Votre e-mail</label>
      <input id="email" type="email" placeholder="prenom@exemple.fr" autocomplete="email">
      <button class="principal large" data-action="lien">Recevoir mon lien de connexion</button>
      <p class="discret" style="margin-top:10px">Aucun mot de passe. Le lien est valable 15 minutes.</p>
    </div>
    ${resumeAttentePublique()}
    <div class="bloc">
      <h3>Accès équipe</h3>
      <label for="code">Code agent ou administrateur</label>
      <input id="code" type="text" placeholder="AGENT-2026">
      <button class="sobre" data-action="backoffice">Ouvrir la console</button>
    </div>`;
}

function resumeAttentePublique() {
  if (!S.vue) return '';
  const lignes = Object.entries(S.vue.attente).map(([code, a]) => {
    const i = S.vue.inscriptions[code];
    return `<tr>
      <td><span class="etiquette ${code}">${echapper(S.vue.statuts[code].libelle)}</span></td>
      <td>${a.basse}–${a.haute} min</td>
      <td class="discret">${i.ouvert ? `Inscriptions jusqu'à ${i.heureLimite}` : echapper(i.motif)}</td>
    </tr>`;
  }).join('');
  return `<div class="bloc"><h3>Attente estimée maintenant</h3><table><tbody>${lignes}</tbody></table></div>`;
}

/* ====================================================== ECRAN VISITEUR === */

function ecranVisiteur() {
  if (!S.moi || !S.vue) return '<p class="chargement">Chargement…</p>';
  const { visiteur, ticket } = S.moi;

  // Etape 1 : consentement et aptitude (F-01, F-02).
  const aConsenti = visiteur.consentements.length >= 2;
  if (!aConsenti || visiteur.apte === null) return ecranConsentement(visiteur);
  if (visiteur.apte === false) {
  return `<div class="bloc danger">
    <h1>Accès refusé</h1>
    <p>Vous avez déclaré ne pas remplir les conditions d’accès à la Salle du Temps.
    L’attraction impose plusieurs G. Par mesure de sécurité, votre inscription est donc bloquée.</p>

    <h2>Vous pensez vous être trompé ?</h2>
    <p>Si vous êtes finalement apte à participer à l’attraction, vous pouvez modifier votre déclaration.</p>

    <button class="sobre" data-action="revenir-aptitude">Je suis bien apte</button>
  </div>`;
}

  // Etape 3 : convoque -> prise de parole plein ecran, il faut se deplacer.
  if (ticket && ticket.etat === 'CONVOQUE') return ecranConvocation(ticket);

  // Etape 2 : pas de ticket -> page attraction. Sinon suivi du ticket.
  if (!ticket) return ecranAttraction(visiteur);
  if (ticket.etat === 'EN_ATTENTE') return ecranMonTicket(ticket);
  return ecranFinParcours(ticket, visiteur);
}

function ecranConsentement(visiteur) {
  return `
    <div class="bloc">
      <h1>Bonjour ${echapper(visiteur.prenom)}</h1>
      <p class="discret">Billet ${echapper(visiteur.refBillet)} —
        <span class="etiquette ${visiteur.statut}">${echapper(S.vue.statuts[visiteur.statut].libelle)}</span></p>
      <h2>Avant de rejoindre la file</h2>
      <label class="case"><input type="checkbox" id="cgu">
        <span>J'accepte les conditions d'utilisation de la file virtuelle.</span></label>
      <label class="case"><input type="checkbox" id="decharge">
        <span>J'ai lu la décharge de responsabilité : la Salle du Temps soumet le corps
        à une pesanteur multipliée, avec une accélération de plusieurs G.</span></label>
      <h2>Votre aptitude</h2>
      <p class="discret">Répondez vous-même. Nous ne conservons que « apte » ou « non apte » :
      aucune information de santé n'entre dans le système.</p>
      <div class="ligne">
        <button class="principal" data-action="apte" data-apte="1">Je suis apte</button>
        <button class="sobre" data-action="apte" data-apte="0">Je ne le suis pas</button>
      </div>
    </div>`;
}

function ecranAttraction(visiteur) {
  const code = visiteur.statut;
  const a = S.vue.attente[code];
  const i = S.vue.inscriptions[code];
  const garantie = S.vue.statuts[code].garantieMin;
  const sansAttente = a.basse === 0 && a.haute === 0;

  const onglets = barreOnglets([
    ['attente', 'Attente'], ['infos', 'Infos'], ['regles', 'Regles'], ['profil', 'Mes donnees'],
  ]);

  if (S.onglet === 'infos') return onglets + blocInfos();
  if (S.onglet === 'regles') return onglets + blocRegles();
  if (S.onglet === 'profil') return onglets + blocProfil(visiteur);

  return `${onglets}
    <div class="bloc accent">
      <h1>${echapper(S.vue.file.nom)}</h1>
      <p class="discret">Votre statut :
        <span class="etiquette ${code}">${echapper(S.vue.statuts[code].libelle)}</span>
        ${garantie ? ` — attente garantie à ${garantie} min` : ''}</p>
      ${sansAttente
        ? '<div class="fourchette">Aucune attente <span class="discret">- entrée immédiate</span></div>'
        : `<div class="fourchette">${a.basse} à ${a.haute} <span class="discret">minutes d'attente</span></div>`}
      ${a.elargie ? '<p class="discret">Fourchette élargie : un incident récent perturbe le débit.</p>' : ''}
      <p class="discret">${a.devant} personne(s) devant vous si vous vous inscrivez maintenant.</p>
      ${i.ouvert
        ? `<p class="discret">Inscriptions ouvertes jusqu'à ${i.heureLimite}.</p>
           <button class="principal large" data-action="rejoindre">Rejoindre la file</button>`
        : `<div class="message info">${echapper(i.motif)}</div>`}
    </div>
    ${blocEtatFile()}`;
}

function ecranMonTicket(ticket) {
  const onglets = barreOnglets([
    ['attente', 'Ma position'], ['infos', 'Infos'], ['regles', 'Regles'], ['profil', 'Mes donnees'],
  ]);
  if (S.onglet === 'infos') return onglets + blocInfos();
  if (S.onglet === 'regles') return onglets + blocRegles();
  if (S.onglet === 'profil') return onglets + blocProfil(S.moi.visiteur);

  return `${onglets}
    <div class="bloc">
      <h3>Votre position dans la file</h3>
      <div class="chiffre">${ticket.position}<span class="unite"> / ${S.vue.compteurs.enAttente}</span></div>
      <p class="discret">Ticket ${echapper(ticket.id)} — inscrit à ${ticket.heureInscription}
        — <span class="etiquette ${ticket.statut}">${echapper(ticket.libelleStatut)}</span></p>
    </div>
    <div class="bloc accent">
      <h3>Attente estimée</h3>
      <div class="fourchette">${ticket.estimation.basse}–${ticket.estimation.haute} <span class="discret">min</span></div>
      <p class="discret">Passage prévu vers ${ticket.heurePrevisionnelle}.</p>
      <p class="discret">Dont environ ${ticket.estimation.minutesVirtuelle} min à profiter du parc,
        puis ${ticket.estimation.minutesFileReelle} min devant l'attraction.</p>
      ${ticket.resteGarantieMin !== null
        ? `<p class="discret">Garantie : ${ticket.resteGarantieMin} min restantes sur votre engagement.</p>` : ''}
      ${ticket.geleParPause
        ? '<div class="message info">Attraction en pause. Votre place est conservée et vos compteurs sont gelés.</div>' : ''}
      ${ticket.avertiFinJournee
        ? '<div class="message erreur">Votre passage avant la fermeture n\'est pas assuré. Vous pouvez vous désister sans pénalité.</div>' : ''}
    </div>
    <div class="bloc">
      <h3>Votre code d'accès</h3>
      <p class="discret">Il s'activera automatiquement dès que nous vous convoquerons.
      Inutile de rester sur l'application : nous vous envoyons un e-mail.</p>
      <p class="discret">Il sera scanné une seule fois, à votre arrivée devant l'attraction.</p>
      <button class="sobre large" data-action="desister">Quitter la file</button>
    </div>
    ${blocEtatFile()}`;
}

function ecranConvocation(ticket) {
  const restant = compteARebours(ticket);
  const urgence = restant.sec <= 120 ? 'urgence' : '';
  return `<div class="convocation"><div class="contenu">
      <h1>C'est votre tour</h1>
      <p class="discret">Rejoignez la file d'attente située devant la Salle du Temps
      et faites scanner ce code à votre arrivée.</p>
      <div class="chiffre ${urgence}">${restant.texte}<span class="unite"> pour arriver sur place</span></div>
      ${restant.grace ? '<div class="message info">Délai dépassé — vous êtes dans le délai de grâce.</div>' : ''}
      ${ticket.geleParPause ? '<div class="message info">Compteur gelé : attraction en pause.</div>' : ''}
      <div class="bloc"><div id="qr"></div>
        <p class="code-secours" id="code-secours">Préparation du code…</p>
        <p class="discret">Code renouvelé toutes les 30 secondes. Une capture d'écran ne fonctionne pas.</p>
      </div>
      <div class="message info">Le décompte s'arrête dès que l'agent a scanné votre code.
        Vous suivrez ensuite la file : un agent vous fera entrer dans la salle dès qu'une place
        se libère (environ ${ticket.devantFileReelle} personne(s) dans la file).</div>
      <p class="discret">L'agent contrôlera aussi votre pièce d'identité.</p>
      <button class="sobre" data-action="desister">Je ne peux pas venir</button>
    </div></div>`;
}

/**
 * Etage 2 : le visiteur est arrive, il patiente devant l'attraction. Plus aucun
 * compte a rebours : il est la, il ne peut plus etre declare absent. Le seul
 * chiffre qui compte devient le nombre de personnes devant lui.
 */
function ecranFileReelle(ticket) {
  const salle = ticket.salle;
  return `<div class="convocation"><div class="contenu">
      <h1>Vous êtes dans la file</h1>
      <p class="discret">Arrivée enregistrée à ${ticket.heureArrivee}. Gardez votre code
      affiché : l'agent le scannera une seconde fois pour vous faire entrer.</p>
      <div class="chiffre">${ticket.devantFileReelle}<span class="unite"> personne(s) devant vous</span></div>
      <p class="discret">Entrée estimée vers ${ticket.heurePrevisionnelle}
        (${ticket.estimation.basse}–${ticket.estimation.haute} min).</p>
      ${salle.pleine
        ? `<div class="message info">La salle est pleine (${salle.occupation}/${salle.capacite}).
           Les entrées reprennent dès que des visiteurs en sortent.</div>`
        : `<div class="message succes">${salle.capacite - salle.occupation} place(s) libre(s) dans la salle.</div>`}
      ${ticket.geleParPause ? '<div class="message info">Attraction en pause. Votre place est conservée.</div>' : ''}
      <div class="bloc"><div id="qr"></div>
        <p class="code-secours" id="code-secours">Préparation du code…</p>
        <p class="discret">Code renouvelé toutes les 30 secondes.</p>
      </div>
      <button class="sobre" data-action="desister">Quitter la file</button>
    </div></div>`;
}

function ecranFinParcours(ticket, visiteur) {
  if (S.onglet === 'profil') {
    return `${barreOnglets([['resume', 'Résumé'], ['profil', 'Mes données']])}${blocProfil(visiteur)}`;
  }

  const textes = {
    VALIDE: ['Code validé', "Suivez la file : un agent vous fera entrer dans la Salle du Temps dès qu'une place se libère. Profitez de la salle aussi longtemps que vous le souhaitez, puis reprenez votre visite du parc."],
    EXPIRE: ['Convocation expirée', "Vous n'avez pas rejoint la file de l'attraction à temps. Vous pouvez vous réinscrire en fin de file."],
    ANNULE: ['Vous avez quitte la file', 'Votre place a été libérée. Vous pouvez vous réinscrire quand vous voulez.'],
    RETIRE: ['Ticket retiré par un agent', ticket.motif || 'Un agent a retiré votre ticket.'],
    PURGE: ['Attraction fermée', ticket.motif || 'L\'attraction a fermé pour la journée.'],
  }[ticket.etat] || ['Parcours terminé', ''];

  return `<div class="bloc">
      <h1>${echapper(textes[0])}</h1>
      <p>${echapper(textes[1])}</p>
      <button class="principal" data-action="rejoindre">Se réinscrire</button>
      <button class="sobre" data-action="onglet" data-onglet="profil">Mes données</button>
    </div>
    ${blocEtatFile()}`;
}

/* --- Blocs partages de l'interface visiteur ------------------------------ */

function blocEtatFile() {
  const v = S.vue;
  return `<div class="bloc">
      <h3>L'attraction en direct</h3>
      <div class="indicateurs">
        <div class="indicateur"><div class="valeur">${v.compteurs.enAttente}</div><div class="titre">dans la file virtuelle</div></div>
        <div class="indicateur"><div class="valeur">${v.compteurs.valides}</div><div class="titre">passages aujourd'hui</div></div>
      </div>
    </div>`;
}

function blocInfos() {
  const v = S.vue;
  return `<div class="bloc">
      <h3>Horaires</h3>
      <p>Inscriptions dès ${v.file.ouvertureFile}. Exploitation de ${v.file.debutExploitation} à ${v.file.finExploitation}.</p>
      <h3>Comment ça marche</h3>
      <p>Vous prenez votre rang depuis votre téléphone et vous profitez du parc. Quand
      votre tour approche, nous vous appelons : vous avez alors ${v.delais.convocationMin} minutes
      pour rejoindre la file d'attente installée devant l'attraction, qui accueille
      ${v.fileReelle.capacite} personnes. Un agent y scanne votre code à l'arrivée ; vous entrez
      ensuite dans la salle dès qu'une place se libère.</p>
      <h3>Capacité</h3>
      <p>La Salle du Temps accueille ${v.salle.capacite} personnes. Chacun en sort quand il le
      souhaite ; un séjour dure entre ${formaterDuree(v.salle.dureeSejourMinSec)} et
      ${formaterDuree(v.salle.dureeSejourMaxSec)}. Les places se libèrent donc en continu,
      à un rythme soutenu : l'essentiel de votre attente se passe dans le parc.</p>
      <h3>Accès</h3>
      <p>La Salle du Temps soumet le corps à une forte pesanteur. L'accès est refusé
      aux personnes ayant déclaré ne pas être aptes.</p>
    </div>`;
}

function blocRegles() {
  const v = S.vue;
  const lignes = Object.entries(v.statuts).map(([code, s]) => `<tr>
      <td><span class="etiquette ${code}">${echapper(s.libelle)}</span></td>
      <td>${s.garantieMin === null ? 'Ordre d\'arrivée' : s.garantieMin === 0 ? 'Accès immédiat' : `${s.garantieMin} min garanties`}</td>
      <td class="discret">${Math.round(s.quotaFenetre * 100)} % des convocations au maximum${s.partMin ? `, ${Math.round(s.partMin * 100)} % réservées` : ''}</td>
    </tr>`).join('');
  return `<div class="bloc">
      <h3>Les trois statuts</h3>
      <table><tbody>${lignes}</tbody></table>
      <h3>Ce que nous garantissons</h3>
      <p>Votre rang d'arrivée ne change jamais. Aucun agent ne peut ajouter quelqu'un devant vous :
      la file ne s'alimente que par les inscriptions des visiteurs.</p>
      <p>En cas d'incident, vos compteurs sont gelés et votre place est conservée.
      Nous ne promettons jamais un passage impossible avant ${v.file.finExploitation}.</p>
    </div>`;
}

function blocProfil(visiteur) {
  return `<div class="bloc">
      <h3>Ce que nous conservons</h3>
      <p class="discret">${echapper(visiteur.email)} · ${echapper(visiteur.prenom)} ${echapper(visiteur.initiale)}.
      · billet ${echapper(visiteur.refBillet)} · aptitude : ${visiteur.apte ? 'apte' : 'non apte'}</p>
      <p class="discret">Tout est effacé le lendemain, sauf la preuve de consentement (3 ans)
      et le journal des actions des opérateurs (12 mois).</p>
      <div class="ligne">
        <button class="sobre" data-action="exporter">Exporter mes données</button>
        <button class="danger" data-action="effacer">Effacer mes données</button>
      </div>
    </div>`;
}

/* ========================================================= ECRAN AGENT === */

function ecranAgent() {
  if (!S.vue) return '<p class="chargement">Connexion au flux temps réel…</p>';
  const onglets = barreOnglets([['scan', 'Scan'], ['file', 'File'], ['incidents', 'Incidents']]);
  if (S.onglet === 'file') return onglets + blocFileAgent();
  if (S.onglet === 'incidents') return onglets + blocIncidents();
  return onglets + blocScan();
}

/**
 * Le poste de l'agent, a l'entree de la file reelle : il scanne le code et
 * lit le verdict. Rien d'autre. L'entree dans la salle est geree par un
 * second agent, sans application.
 */
function blocScan() {
  const s = S.scan;
  const mots = { ACCEPTE: 'Code valide', REFUSE: 'Refusé' };

  return `
    ${s ? `<div class="verdict ${s.verdict}">
        <div class="mot">${mots[s.verdict] || s.verdict}</div>
        ${s.visiteur ? `<p>${echapper(s.visiteur.prenom)} ${echapper(s.visiteur.initiale)}. —
          ${echapper(S.vue?.statuts?.[s.visiteur.statut]?.libelle || s.visiteur.statut)}.
          ${s.verdict === 'ACCEPTE' ? 'Contrôlez la pièce d\'identité, puis laissez passer dans la file.' : ''}</p>` : ''}
        ${s.motif ? `<p>${echapper(s.motif)}</p>` : ''}
      </div>` : ''}
    <div class="bloc">
      <h3>Scanner un code</h3>
      <p class="discret">Scannez le code du visiteur à son arrivée dans la file.
      Un code ne sert qu'une fois.</p>
      <label for="jeton">Code du visiteur (caméra ou saisie manuelle)</label>
      <input id="jeton" type="text" placeholder="tk_xxxxxxxx.xxxxxxx.xxxxxxxxxxxx" autocomplete="off">
      <div class="ligne">
        <button class="principal" data-action="scanner">Scanner</button>
        <button class="sobre" data-action="camera">Utiliser la caméra</button>
      </div>
      <video id="video" playsinline style="display:none;width:100%;border-radius:8px;margin-top:10px"></video>
      <p class="discret">Le code tourne toutes les 30 secondes : une capture d'écran est refusée.</p>
    </div>`;
}

function blocFileAgent() {
  const etatLisible = (t) => (t.zone === 'EN_ROUTE'
    ? `convoqué · ${t.resteConvocationSec}s pour arriver`
    : 'en attente dans le parc');

  const lignes = (S.agent?.file || []).map((t) => `<tr>
      <td>${t.position}</td>
      <td><span class="etiquette ${t.statut}">${echapper(t.libelleStatut)}</span></td>
      <td>${echapper(t.visiteur)}</td>
      <td class="discret">${t.heureInscription}</td>
      <td class="discret">${etatLisible(t)}</td>
      <td class="discret">${t.resteGarantieMin === null ? '—' : `${t.resteGarantieMin} min`}</td>
      <td><button class="sobre" data-action="retirer" data-id="${t.id}">Retirer</button></td>
    </tr>`).join('');

  return `<div class="bloc">
      <h3>File en cours</h3>
      <p class="discret">Dans l'ordre où vous les rencontrerez : d'abord les convoqués qui se
      rendent à l'attraction, puis la file virtuelle. Un visiteur scanné sort de la liste.
      Aucun bouton d'ajout : la file ne s'alimente que par les inscriptions des visiteurs.</p>
      <div class="defilant"><table>
        <thead><tr><th>#</th><th>Statut</th><th>Visiteur</th><th>Inscrit</th><th>État</th><th>Garantie</th><th></th></tr></thead>
        <tbody>${lignes || '<tr><td colspan="7" class="vide-liste">File vide.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

function blocIncidents() {
  const enPause = S.vue?.file.etat === 'EN_PAUSE';
  const fermee = S.vue?.file.etat === 'PURGEE';
  return `<div class="bloc">
      <h3>Exploitation</h3>
      <label for="motif">Motif (obligatoire et tracé)</label>
      <input id="motif" type="text" placeholder="Panne du sas, évacuation, maintenance…">
      <div class="ligne">
        ${enPause
          ? '<button class="principal" data-action="reprendre">Reprendre l\'exploitation</button>'
          : '<button class="sobre" data-action="pause">Mettre en pause</button>'}
        <button class="sobre" data-action="incident">Déclarer un incident</button>
        ${fermee
          ? '<button class="sobre" data-action="rouvrir">Rouvrir la file</button>'
          : '<button class="danger" data-action="purger">Purger la file</button>'}
      </div>
      <p class="discret">La pause gèle tous les compteurs et prévient les visiteurs.
      La purge demande une double confirmation et annule tous les tickets.</p>
    </div>
    <div class="bloc">
      <h3>Derniers scans</h3>
      <button class="sobre" data-action="incidents-charger">Actualiser</button>
      <div class="defilant"><table><tbody>
        ${(S.incidents?.scans || []).map((s) => `<tr>
          <td>${echapper(s.verdict)}</td>
          <td class="discret">${echapper(s.motif || '')}</td>
          <td class="discret">${echapper(s.ticketId || '')}</td></tr>`).join('')
          || '<tr><td class="vide-liste">Aucun scan enregistré.</td></tr>'}
      </tbody></table></div>
    </div>`;
}

/* ========================================================= ECRAN ADMIN === */

function ecranAdmin() {
  if (!S.vue) return '<p class="chargement">Connexion au flux temps réel…</p>';
  const onglets = barreOnglets([
    ['apercu', 'Vue d\'ensemble'], ['attentes', 'Temps d\'attente'],
    ['affluence', 'Affluence'], ['regles', 'Règles'], ['audit', 'Log'], ['file', 'File'],
    ['utilisateurs', 'Utilisateur'],
  ]);
  if (!S.admin) return onglets + '<p class="chargement">Chargement…</p>';
  if (S.onglet === 'attentes') return onglets + blocAttentes();
  if (S.onglet === 'affluence') return onglets + blocAffluence();
  if (S.onglet === 'regles') return onglets + blocReglesAdmin();
  if (S.onglet === 'audit') return onglets + blocAudit();
  if (S.onglet === 'file') return onglets + blocFileAgent();
  if (S.onglet === 'utilisateurs') return onglets + blocUtilisateurs();
  return onglets + blocApercu();
}

function blocApercu() {
  const m = S.admin.metriques;
  const ind = (valeur, titre) => `<div class="indicateur"><div class="valeur">${valeur}</div><div class="titre">${titre}</div></div>`;
  return `<div class="indicateurs">
      ${ind(m.totaux.enAttente, 'dans la file')}
      ${ind(m.totaux.valides, 'codes validés')}
      ${ind(`≈ ${m.totaux.enFileReelle}`, 'devant l\'attraction (estimé)')}
      ${ind(`${m.remplissage.sallePct} %`, 'remplissage salle')}
      ${ind(`${m.remplissage.fileReellePct} %`, 'remplissage file réelle (estimé)')}
      ${ind(`${m.garantieSaiyanPct} %`, 'garantie Saiyan tenue')}
      ${ind(`${m.ecartAnnonceReelPct} %`, 'écart annoncé / réel')}
      ${ind(`${m.absences.tauxPct} %`, 'absences à la convocation')}
      ${ind(m.finDeJournee.ticketsNonServis, 'non servis à la fermeture')}
      ${ind(`${m.finDeJournee.tauxDesistementPct} %`, 'désistements')}
      ${ind(`${m.incidents.dureeCumuleeMin} min`, `indisponibilité (${m.incidents.nombre} incidents)`)}
    </div>
    <div class="bloc">
      <h3>Répartition des passages</h3>
      <table><tbody>${Object.entries(m.repartitionPassages).map(([code, n]) => `<tr>
        <td><span class="etiquette ${code}">${echapper(S.vue.statuts[code]?.libelle || code)}</span></td>
        <td>${n} passage(s)</td></tr>`).join('') || '<tr><td class="vide-liste">Aucun passage.</td></tr>'}</tbody></table>
    </div>`;
}

function blocAttentes() {
  const m = S.admin.metriques;
  return `<div class="bloc">
      <h3>Temps d'attente par statut</h3>
      <table>
        <thead><tr><th>Statut</th><th>Actuel</th><th>Moyenne vécue</th><th>90e centile</th><th>Passages</th></tr></thead>
        <tbody>${Object.entries(m.attentes).map(([code, a]) => `<tr>
          <td><span class="etiquette ${code}">${echapper(a.libelle)}</span></td>
          <td>${a.actuelMin} min</td><td>${a.moyenneMin} min</td>
          <td>${a.p90Min} min</td><td>${a.passages}</td></tr>`).join('')}</tbody>
      </table>
      <p class="discret">L'écart moyen entre l'attente annoncée à l'inscription et l'attente
      réellement vécue est de ${m.ecartAnnonceReelPct} % (objectif : moins de 10 %).</p>
    </div>`;
}

function blocAffluence() {
  const v = S.vue;
  const pctSalle = Math.min(100, Math.round((v.salle.occupation / v.salle.capacite) * 100));
  const pctFile = Math.min(100, Math.round((v.fileReelle.occupation / v.fileReelle.capacite) * 100));
  return `<div class="bloc">
      <h3>Capteur de la Salle du Temps</h3>
      <div class="chiffre">${v.salle.occupation}<span class="unite"> / ${v.salle.capacite} places</span></div>
      <div class="jauge ${pctSalle >= 90 ? 'pleine' : ''}"><span style="width:${pctSalle}%"></span></div>
      <p class="discret">Source : ${echapper(v.salle.source)} · relevé il y a ${v.salle.age ?? '?'} s
        ${v.salle.erreur ? ` · erreur : ${echapper(v.salle.erreur)}` : ''}</p>
      <p class="discret">Les visiteurs sortent quand ils le souhaitent : le capteur est la seule
      source qui sache combien de personnes se trouvent réellement dans la salle.</p>
      <label for="occupation">Forcer l'occupation (démonstration ; vide = capteur réel)</label>
      <input id="occupation" type="number" min="0" placeholder="ex. 50">
      <button class="sobre" data-action="capteur">Appliquer</button>
    </div>
    <div class="bloc">
      <h3>File d'attente devant l'attraction</h3>
      <div class="chiffre">${v.fileReelle.occupation}<span class="unite"> / ${v.fileReelle.capacite} places</span></div>
      <div class="jauge ${pctFile >= 90 ? 'pleine' : ''}"><span style="width:${pctFile}%"></span></div>
      <p class="discret">Environ ${v.fileReelle.presents} personne(s) sur place, ${v.fileReelle.enRoute} en route.
      L'entrée dans la salle n'étant pas scannée, le nombre de personnes sur place est estimé
      à partir des scans et du débit. L'ordonnanceur convoque tant qu'il reste des places,
      et s'arrête à ${v.fileReelle.capacite}.</p>
    </div>
    <div class="bloc">
      <h3>Débit</h3>
      <p>Un séjour dure de ${formaterDuree(v.salle.dureeSejourMinSec)} à ${formaterDuree(v.salle.dureeSejourMaxSec)}
      (${formaterDuree(v.salle.dureeSejourMoyenneSec)} en moyenne) : les ${v.salle.capacite} places se renouvellent
      donc en continu, soit un débit nominal théorique de ${v.salle.debitNominal} visiteurs par heure.</p>
      <p class="discret">Il n'y a ni cycle ni fournée : la salle fonctionne en flux continu.
      À ce rythme, la salle n'est plus le goulet d'étranglement : c'est le contrôle à l'entrée
      (scan et pièce d'identité) et le trajet des convoqués qui fixent le débit réel.
      Le débit observé sur les 30 dernières minutes corrige cette hypothèse
      dans l'estimation affichée aux visiteurs.</p>
    </div>`;
}

/** Champs de reglage exposes au parametrage a chaud (RG-15 / F-16). */
const CHAMPS_REGLES = [
  ['capaciteSalle', 'Capacité de la Salle du Temps'],
  ['capaciteFileReelle', 'Capacité de la file réelle'],
  ['dureeSejourMinSec', 'Durée minimale de séjour (s)'],
  ['dureeSejourMaxSec', 'Durée maximale de séjour (s)'],
  ['fenetreQuotaConvocations', 'Fenêtre des quotas (convocations)'],
  ['horizonUrgenceMin', 'Horizon d\'urgence des garanties (min)'],
  ['delaiConvocationSec', 'Délai pour rejoindre la file réelle (s)'],
  ['delaiGraceSec', 'Délai de grâce (s)'],
  ['rappelAvantFinSec', 'Rappel avant expiration (s)'],
  ['margeSecuriteMin', 'Marge de sécurité (min)'],
  ['seuilVigilanceMin', 'Seuil de vigilance (min)'],
  ['ouvertureFile', 'Ouverture des inscriptions (min depuis minuit)'],
  ['debutExploitation', 'Début d\'exploitation'],
  ['finExploitation', 'Fin d\'exploitation'],
  ['periodeTickMs', 'Période de l\'ordonnanceur (ms)'],
  ['capteurUrl', 'URL du capteur'],
  ['billetterieUrl', 'URL de la billetterie'],
];

function blocReglesAdmin() {
  const r = S.admin.regles;
  const champs = CHAMPS_REGLES.map(([cle, libelle]) => `
    <div><label for="r-${cle}">${libelle}</label>
    <input id="r-${cle}" data-regle="${cle}" value="${echapper(r[cle])}"></div>`).join('');

  const quotas = Object.entries(r.statuts).map(([code, s]) => `
    <div><label for="q-${code}">${echapper(s.libelle)} — part maximale des ${r.fenetreQuotaConvocations} dernières convocations (%)</label>
    <input id="q-${code}" data-quota="${code}" type="number" value="${Math.round(s.quotaFenetre * 100)}"></div>
    <div><label for="p-${code}">${echapper(s.libelle)} — part minimale réservée (%)</label>
    <input id="p-${code}" data-part="${code}" type="number" value="${Math.round((s.partMin || 0) * 100)}"></div>`).join('');

  return `<div class="bloc">
      <h3>Paramètres d'exploitation</h3>
      <p class="discret">Toute modification est appliquée immédiatement, sans redémarrage, et tracée dans l'audit.</p>
      ${champs}${quotas}
      <button class="principal" data-action="enregistrer-regles">Enregistrer</button>
    </div>
    <div class="bloc">
      <h3>Horloge de démonstration</h3>
      <p class="discret">Pour montrer l'ouverture de 8h, un parcours complet ou la fermeture
      de 19h sans attendre la journée entière.</p>
      <div class="ligne">
        <div><label for="heure">Heure</label><input id="heure" type="time" value="${S.vue.horloge.heure}"></div>
        <div><label for="vitesse">Vitesse</label><input id="vitesse" type="number" value="${S.vue.horloge.vitesse}"></div>
      </div>
      <div class="ligne">
        <button class="sobre" data-action="horloge">Appliquer</button>
        <button class="sobre" data-action="horloge-reel">Revenir au temps réel</button>
      </div>
    </div>
    <div class="bloc">
      <h3>Jeu de données</h3>
      <p class="discret">Les visiteurs suivent le vrai parcours : inscription, convocation,
      scan à l'entrée de la file réelle. Rien n'est écrit directement dans le journal.</p>
      <div class="ligne">
        <div><label for="nombre">Inscrits</label><input id="nombre" type="number" value="24"></div>
        <div><label for="scannes">Dont scannés</label><input id="scannes" type="number" value="12"></div>
      </div>
      <button class="sobre" data-action="seed">Peupler les trois étages</button>
    </div>`;
}

function blocAudit() {
  const lignes = S.admin.audit.map((a) => `<tr>
      <td class="discret">${new Date(a.ts).toLocaleTimeString('fr-FR')}</td>
      <td>${echapper(a.acteur)}</td><td>${echapper(a.action)}</td>
      <td class="discret">${echapper(a.details)}</td></tr>`).join('');
  return `<div class="bloc">
      <h3>Log</h3>
      <p class="discret">Toutes les actions des opérateurs, conservées 12 mois.</p>
      <div class="defilant"><table>
        <thead><tr><th>Heure</th><th>Acteur</th><th>Action</th><th>Détail</th></tr></thead>
        <tbody>${lignes || '<tr><td colspan="4" class="vide-liste">Aucune action.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

/**
 * Onglet Utilisateur : l'administrateur corrige les informations d'un visiteur
 * (prenom, initiale, statut, aptitude). Chaque ligne s'enregistre a part.
 */
function blocUtilisateurs() {
  const statuts = S.vue.statuts;
  const lignes = (S.admin.utilisateurs || []).map((u) => `<tr>
      <td class="discret">${echapper(u.email)}<br>${echapper(u.refBillet)}</td>
      <td><input id="u-prenom-${u.id}" value="${echapper(u.prenom)}"></td>
      <td><input id="u-initiale-${u.id}" value="${echapper(u.initiale)}" maxlength="3" style="width:4em"></td>
      <td><select id="u-statut-${u.id}">${Object.entries(statuts).map(([code, st]) => `
        <option value="${code}" ${u.statut === code ? 'selected' : ''}>${echapper(st.libelle)}</option>`).join('')}
      </select></td>
      <td><select id="u-apte-${u.id}">
        ${u.apte === null ? '<option value="" selected>Non déclaré</option>' : ''}
        <option value="1" ${u.apte === true ? 'selected' : ''}>Apte</option>
        <option value="0" ${u.apte === false ? 'selected' : ''}>Pas apte</option>
      </select></td>
      <td><button class="sobre" data-action="enregistrer-utilisateur" data-id="${u.id}">Enregistrer</button></td>
    </tr>`).join('');

  return `<div class="bloc">
      <h3>Utilisateurs</h3>
      <p class="discret">Toute modification est tracée dans le log. Un changement de statut
      vaut pour les prochaines inscriptions du visiteur.</p>
      <div class="defilant"><table>
        <thead><tr><th>E-mail / billet</th><th>Prénom</th><th>Initiale</th><th>Statut</th><th>Aptitude</th><th></th></tr></thead>
        <tbody>${lignes || '<tr><td colspan="6" class="vide-liste">Aucun utilisateur.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

/* ------------------------------------------------------------- Onglets --- */

function barreOnglets(liste) {
  return `<nav class="onglets">${liste.map(([cle, libelle]) => `
    <button data-action="onglet" data-onglet="${cle}" aria-selected="${S.onglet === cle}">${libelle}</button>`).join('')}</nav>`;
}

/* --------------------------------------------------- Compte a rebours ---- */

function compteARebours(ticket) {
  // Le serveur envoie un reste ; on le decremente localement pour un affichage
  // fluide, sans multiplier les appels reseau.
  const ecoule = ticket.geleParPause ? 0 : Math.floor((Date.now() - S.recuA) / 1000);
  const reste = Math.max(0, ticket.resteSec - ecoule);
  const resteGrace = Math.max(0, ticket.resteGraceSec - ecoule);
  const sec = reste > 0 ? reste : resteGrace;
  const m = Math.floor(sec / 60), s = sec % 60;
  return { sec, grace: reste === 0 && resteGrace > 0, texte: `${m}:${String(s).padStart(2, '0')}` };
}

/* --------------------------------------------------------- QR code ------- */

// Le jeton est valable 30 secondes : inutile de le redemander a chaque rendu.
let cacheJeton = { jeton: null, expireA: 0 };

async function dessinerQr() {
  const boite = document.getElementById('qr');
  if (!boite || S.moi?.ticket?.etat !== 'CONVOQUE') {
    cacheJeton = { jeton: null, expireA: 0 };
    return;
  }
  try {
    if (!cacheJeton.jeton || Date.now() >= cacheJeton.expireA) {
      const r = await api('GET', `/api/tickets/${S.moi.ticket.id}/qr`);
      cacheJeton = { jeton: r.jeton, expireA: Date.now() + Math.max(1, r.expireDans - 1) * 1000 };
    }
    boite.innerHTML = '';
    if (window.QRCode) new window.QRCode(boite, { text: cacheJeton.jeton, width: 220, height: 220 });
    else boite.textContent = 'Code a saisir manuellement par l\'agent :';
    const secours = document.getElementById('code-secours');
    if (secours) secours.textContent = cacheJeton.jeton;
  } catch { /* le ticket n'est plus convoque : le prochain rendu corrigera */ }
}

/* ------------------------------------------------------------- Actions --- */

function brancherActions(racine) {
  racine.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => executer(el.dataset.action, el.dataset));
  });
}

async function executer(action, data) {
  const valeur = (id) => document.getElementById(id)?.value?.trim() ?? '';

  switch (action) {
    case 'deconnexion': return seDeconnecter();

    case 'onglet': S.onglet = data.onglet; return rendre();
    case 'fermer-modal': return fermerModal();
    case 'confirmer-modal': {
      const action = S.modal?.action;
      fermerModal();
      return executer(action, {});
    }


    case 'lien': {
      try {
        const r = await api('POST', '/api/auth/magic-link', { email: valeur('email') });
        // Sans SMTP, on ouvre directement la session : le message reste visible
        // dans la boite de l'administrateur, comme un vrai e-mail envoye.
        const v = await api('POST', '/api/auth/verify', { jeton: r.jeton });
        ouvrirSession(v.session, 'visiteur');
        S.onglet = 'attente';
        return agir(async () => v, `Connecté. Un e-mail de confirmation a été envoyé à ${v.visiteur.email}.`);
      } catch (e) { return annoncer(e.message, 'erreur'); }
    }

    case 'backoffice': {
      try {
        const r = await api('POST', '/api/auth/backoffice/login', { code: valeur('code') });
        ouvrirSession(r.session, r.role);
        S.onglet = r.role === 'admin' ? 'apercu' : 'scan';
        return rafraichir();
      } catch (e) { return annoncer(e.message, 'erreur'); }
    }

    case 'apte': {
      const apte = data.apte === '1';
      const cgu = document.getElementById('cgu')?.checked;
      const decharge = document.getElementById('decharge')?.checked;
      if (!cgu || !decharge) {
        return annoncer('Acceptez les conditions et la décharge pour continuer.', 'erreur');
      }
      return agir(async () => {
        await api('POST', '/api/me/consents', { cgu, decharge });
        await api('POST', '/api/me/eligibility', { apte });
      });
    }

    case 'revenir-aptitude':
      return agir(() => api('POST', '/api/me/eligibility', { apte: true }));

    case 'rejoindre':
      return agir(() => api('POST', `/api/queues/${FILE}/tickets`), 'Vous êtes dans la file.');

    case 'desister':
      return ouvrirModal(
        'Quitter la file ?',
        'Cette action est définitive et libère votre place. Vous devrez vous réinscrire si vous changez d\'avis.',
        'desister-confirme',
        'Quitter la file'
      );

    case 'desister-confirme':
      return agir(() => api('DELETE', `/api/tickets/${S.moi.ticket.id}`), 'Vous avez quitté la file.');

    case 'exporter': {
      const donnees = await api('GET', '/api/me/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(donnees, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'mes-donnees-waitless.json'; a.click();
      URL.revokeObjectURL(url);
      return annoncer('Export téléchargé.', 'succes');
    }

    case 'effacer': {
      if (!confirm('Effacer définitivement vos données ? Votre ticket sera annulé.')) return;
      await agir(() => api('DELETE', '/api/me'));
      return seDeconnecter();
    }

    case 'scanner': {
      try {
        S.scan = await api('POST', '/api/agent/scans', { jeton: valeur('jeton') });
        const champ = document.getElementById('jeton');
        if (champ) champ.value = '';
        return rafraichir();
      } catch (e) { return annoncer(e.message, 'erreur'); }
    }

    case 'camera': return scannerAvecCamera();

    case 'retirer': {
      const motif = prompt('Motif du retrait (obligatoire) :');
      if (!motif) return;
      return agir(() => api('DELETE', `/api/agent/tickets/${data.id}?motif=${encodeURIComponent(motif)}`), 'Ticket retiré.');
    }

    case 'pause':
      return agir(() => api('POST', `/api/agent/queues/${FILE}/pause`, { motif: valeur('motif') }),
        'File en pause, compteurs gelés.');

    case 'reprendre':
      return agir(() => api('POST', `/api/agent/queues/${FILE}/resume`), 'Exploitation reprise.');

    case 'purger': {
      if (!confirm('Purger la file ? Tous les tickets seront annulés.')) return;
      if (prompt('Tapez PURGER pour confirmer :') !== 'PURGER') return;
      return agir(() => api('POST', `/api/agent/queues/${FILE}/purge`,
        { motif: valeur('motif'), confirmation: 'PURGER' }), 'File purgée.');
    }

    case 'rouvrir':
      return agir(() => api('POST', `/api/agent/queues/${FILE}/reopen`), 'File rouverte.');

    case 'incident':
      return agir(() => api('POST', '/api/agent/incidents', { motif: valeur('motif') }), 'Incident enregistré.');

    case 'incidents-charger': {
      S.incidents = await api('GET', '/api/agent/incidents');
      return rendre();
    }

    case 'enregistrer-utilisateur': {
      const id = data.id;
      const apte = valeur(`u-apte-${id}`);
      return agir(() => api('PUT', `/api/admin/users/${encodeURIComponent(id)}`, {
        prenom: valeur(`u-prenom-${id}`),
        initiale: valeur(`u-initiale-${id}`),
        statut: valeur(`u-statut-${id}`),
        apte: apte === '' ? null : apte === '1',
      }), 'Utilisateur mis à jour.');
    }

    case 'capteur':
      return agir(() => api('PUT', '/api/mock/sensors', { occupation: valeur('occupation') || null }));

    case 'enregistrer-regles': {
      const patch = {};
      document.querySelectorAll('[data-regle]').forEach((i) => { patch[i.dataset.regle] = i.value; });
      const statuts = {};
      document.querySelectorAll('[data-quota]').forEach((i) => {
        statuts[i.dataset.quota] = { ...statuts[i.dataset.quota], quotaFenetre: Number(i.value) / 100 };
      });
      document.querySelectorAll('[data-part]').forEach((i) => {
        statuts[i.dataset.part] = { ...statuts[i.dataset.part], partMin: Number(i.value) / 100 };
      });
      patch.statuts = statuts;
      return agir(() => api('PUT', '/api/admin/config/rules', patch), 'Règles appliquées immédiatement.');
    }

    case 'horloge':
      return agir(() => api('POST', '/api/admin/clock',
        { heure: valeur('heure'), vitesse: Number(valeur('vitesse')) }), 'Horloge réglée.');

    case 'horloge-reel':
      return agir(() => api('POST', '/api/admin/clock', { reel: true }), 'Retour au temps réel.');

    case 'seed':
      return agir(() => api('POST', '/api/admin/seed', {
        nombre: Number(valeur('nombre')),
        scannes: Number(valeur('scannes')),
      }), 'File peuplée.');
  }
}

/* ------------------------------------------- Scan par la camera (option) - */

async function scannerAvecCamera() {
  // BarcodeDetector est natif et rapide, mais absent de Safari/iOS : jsQR
  // (charge dans index.html) sert de repli, via un canvas hors ecran.
  const detecteurNatif = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!detecteurNatif && !window.jsQR) {
    return annoncer('Ce navigateur ne sait pas lire les QR codes. Saisissez le code à la main.', 'info');
  }
  const video = document.getElementById('video');
  try {
    const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.style.display = 'block';
    video.srcObject = flux;
    await video.play();

    const canvas = detecteurNatif ? null : document.createElement('canvas');
    const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;

    const detecter = async () => {
      if (detecteurNatif) {
        const codes = await detecteurNatif.detect(video).catch(() => []);
        return codes[0]?.rawValue || null;
      }
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(image.data, image.width, image.height)?.data || null;
    };

    const boucle = async () => {
      if (!video.srcObject) return;
      const valeur = await detecter();
      if (valeur) {
        flux.getTracks().forEach((t) => t.stop());
        video.srcObject = null; video.style.display = 'none';
        document.getElementById('jeton').value = valeur;
        return executer('scanner', {});
      }
      requestAnimationFrame(boucle);
    };
    boucle();
  } catch {
    annoncer('Caméra indisponible. Saisissez le code à la main.', 'info');
  }
}

/* -------------------------------------------------------- Demarrage ------ */

// Connexion depuis un lien magique (?connexion=...)
const params = new URLSearchParams(location.search);
if (params.get('connexion')) {
  api('POST', '/api/auth/verify', { jeton: params.get('connexion') })
    .then((v) => { ouvrirSession(v.session, 'visiteur'); history.replaceState({}, '', '/'); rafraichir(); })
    .catch(() => annoncer('Lien invalide ou expiré.', 'erreur'));
}

ouvrirFlux();
rafraichir();

// Compte a rebours : seul rafraichissement a la seconde, et uniquement quand un
// ticket est convoque. Le reste de l'interface suit le rythme du serveur.
setInterval(() => {
  if (S.role === 'visiteur' && S.moi?.ticket?.etat === 'CONVOQUE' && !S.modal) rendre();
}, 1000);