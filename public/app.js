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
  vue: null,
  moi: null,
  agent: null,
  admin: null,
  onglet: 'attente',
  message: null,
  scan: null,
  recuA: 0,
};

/* ------------------------------------------------------------ Utilitaires */

const $ = (sel) => document.querySelector(sel);

function echapper(t) {
  return String(t ?? '').replace(
    /[&<>"]/g,
    (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c])
  );
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

  if (!reponse.ok) {
    throw new Error(donnees.erreur || `Erreur ${reponse.status}`);
  }

  return donnees;
}

function annoncer(texte, type = 'info') {
  S.message = texte ? { texte, type } : null;
  rendre();
}

/** Enveloppe les actions : affiche l'erreur métier telle que le serveur la formule. */
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

  S.session = null;
  S.role = null;
  S.moi = null;
  S.agent = null;
  S.admin = null;

  rendre();
}

function ouvrirSession(jeton, role) {
  S.session = jeton;
  S.role = role;

  localStorage.setItem('waitless.session', jeton);
  localStorage.setItem('waitless.role', role);
}

/* ------------------------------------------------- Chargement des données */

async function rafraichir() {
  try {
    if (S.role === 'visiteur') {
      S.moi = await api('GET', '/api/me');
    }

    if (S.role === 'agent' || S.role === 'admin') {
      S.agent = await api('GET', '/api/agent/queue');
    }

    if (S.role === 'admin') {
      const [metriques, regles, audit] = await Promise.all([
        api('GET', '/api/admin/metrics'),
        api('GET', '/api/admin/config/rules'),
        api('GET', '/api/admin/audit-logs'),
      ]);

      S.admin = {
        metriques,
        regles: regles.regles,
        audit: audit.audit,
      };
    }

    S.recuA = Date.now();
  } catch (e) {
    if (/401|Session|Authentification/i.test(e.message)) {
      seDeconnecter();
    }
  }

  rendre();
}

/** Flux temps réel : le serveur pousse l'état de la file à chaque battement. */
function ouvrirFlux() {
  const source = new EventSource(`/api/queues/${FILE}/stream`);

  source.onmessage = (ev) => {
    try {
      S.vue = JSON.parse(ev.data);
    } catch {
      return;
    }

    const saisieEnCours = [
      'INPUT',
      'TEXTAREA',
      'SELECT',
    ].includes(document.activeElement?.tagName);

    if (S.session) {
      rafraichirDiscret(saisieEnCours);
    } else if (!saisieEnCours) {
      rendre();
    } else {
      rendreBandeau();
    }
  };

  source.onerror = () => rendreBandeau();
}

async function rafraichirDiscret(saisieEnCours) {
  try {
    if (S.role === 'visiteur') {
      S.moi = await api('GET', '/api/me');
    }

    if (S.role === 'agent' || S.role === 'admin') {
      S.agent = await api('GET', '/api/agent/queue');
    }

    if (S.role === 'admin' && S.onglet !== 'regles') {
      S.admin = {
        ...S.admin,
        metriques: await api('GET', '/api/admin/metrics'),
        audit: (await api('GET', '/api/admin/audit-logs')).audit,
      };
    }

    S.recuA = Date.now();
  } catch {
    // Le bandeau signalera la coupure.
  }

  if (saisieEnCours) {
    rendreBandeau();
  } else {
    rendre();
  }
}

/* ------------------------------------------------------------ Rendu ----- */

function rendre() {
  rendreBandeau();

  const app = $('#app');

  if (!app) return;

  app.className =
    S.role === 'agent' || S.role === 'admin'
      ? 'large'
      : '';

  let html = S.message
    ? `<div class="message ${S.message.type}">
        ${echapper(S.message.texte)}
      </div>`
    : '';

  if (!S.session) {
    html += ecranConnexion();
  } else if (S.role === 'visiteur') {
    html += ecranVisiteur();
  } else if (S.role === 'agent') {
    html += ecranAgent();
  } else if (S.role === 'admin') {
    html += ecranAdmin();
  }

  app.innerHTML = html;

  brancherActions(app);
  dessinerQr();

  const pied = $('#pied');

  if (pied) {
    pied.innerHTML =
      '<small>Waitless — démonstrateur. Données fictives, effacées chaque jour.</small>';
  }
}

function rendreBandeau() {
  const bandeau = $('#bandeau');

  if (!bandeau) return;

  const v = S.vue;

  const etats = {
    OUVERTE: '',
    EN_PAUSE: 'pause',
    PURGEE: 'alerte',
  };

  bandeau.innerHTML = `
    <span class="horloge">
      ${v ? v.horloge.heure : '--:--'}
    </span>

    ${
      v && v.horloge.vitesse !== 1
        ? `<span class="pastille">x${v.horloge.vitesse}</span>`
        : ''
    }

    <span>
      ${v ? echapper(v.file.nom) : 'Waitless'}
    </span>

    ${
      v
        ? `<span class="pastille ${etats[v.file.etat] || ''}">
            ${libelleEtatFile(v)}
          </span>`
        : ''
    }

    ${
      v
        ? `<span class="pastille">
            Salle ${v.capteur.occupation}/${v.capteur.capacite}
          </span>`
        : ''
    }

    <span class="pousse">
      ${
        S.role
          ? `<button data-action="deconnexion">
              Quitter (${S.role})
            </button>`
          : ''
      }
    </span>
  `;

  bandeau
    .querySelectorAll('[data-action]')
    .forEach((el) => {
      el.addEventListener('click', () => {
        executer(el.dataset.action, el.dataset);
      });
    });
}

function libelleEtatFile(v) {
  if (v.file.etat === 'EN_PAUSE') {
    return `En pause — ${v.file.motifPause}`;
  }

  if (v.file.etat === 'PURGEE') {
    return 'Fermée';
  }

  return v.file.enExploitation
    ? 'En exploitation'
    : 'Hors exploitation';
}

/* ===================================================== ECRAN CONNEXION === */

function ecranConnexion() {
  return `
    <div class="bloc">
      <h1>La Salle du Temps, sans la queue</h1>

      <p class="discret">
        Inscrivez-vous depuis votre téléphone, profitez du parc,
        et revenez quand nous vous appelons.
      </p>

      <label for="email">Votre e-mail</label>

      <input
        id="email"
        type="email"
        placeholder="prenom@exemple.fr"
        autocomplete="email"
      >

      <button
        class="principal large"
        data-action="lien"
      >
        Recevoir mon lien de connexion
      </button>

      <p class="discret" style="margin-top:10px">
        Aucun mot de passe. Le lien est valable 15 minutes.
      </p>
    </div>

    ${resumeAttentePublique()}

    <div class="bloc">
      <h3>Accès équipe</h3>

      <label for="code">
        Code agent ou administrateur
      </label>

      <input
        id="code"
        type="text"
        placeholder="AGENT-2026"
      >

      <button
        class="sobre"
        data-action="backoffice"
      >
        Ouvrir la console
      </button>
    </div>
  `;
}

function resumeAttentePublique() {
  if (!S.vue) return '';

  const lignes = Object.entries(S.vue.attente)
    .map(([code, a]) => {
      const i = S.vue.inscriptions[code];

      return `
        <tr>
          <td>
            <span class="etiquette ${code}">
              ${echapper(S.vue.statuts[code].libelle)}
            </span>
          </td>

          <td>
            ${a.basse}–${a.haute} min
          </td>

          <td class="discret">
            ${
              i.ouvert
                ? `Inscriptions jusqu'à ${i.heureLimite}`
                : echapper(i.motif)
            }
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="bloc">
      <h3>Attente estimée maintenant</h3>

      <table>
        <tbody>
          ${lignes}
        </tbody>
      </table>
    </div>
  `;
}

/* ====================================================== ECRAN VISITEUR === */

function ecranVisiteur() {
  if (!S.moi || !S.vue) {
    return '<p class="chargement">Chargement…</p>';
  }

  const { visiteur, ticket } = S.moi;

  const aConsenti = visiteur.consentements.length >= 2;

  if (!aConsenti || visiteur.apte === null) {
    return ecranConsentement(visiteur);
  }

  if (visiteur.apte === false) {
    return `
      <div class="bloc danger">
        <h1>Accès non autorisé</h1>

        <p>
          Vous avez déclaré ne pas remplir les conditions d'accès
          à la Salle du Temps.
          L'attraction impose plusieurs G ; par sécurité,
          l'inscription est bloquée.
        </p>

        <button
          class="sobre"
          data-action="revenir-aptitude"
        >
          Je me suis trompé, je suis apte
        </button>
      </div>
    `;
  }

  if (ticket && ticket.etat === 'CONVOQUE') {
    return ecranConvocation(ticket);
  }

  if (!ticket) {
    return ecranAttraction(visiteur);
  }

  if (ticket.etat === 'EN_ATTENTE') {
    return ecranMonTicket(ticket);
  }

  return ecranFinParcours(ticket);
}

function ecranConsentement(visiteur) {
  return `
    <div class="bloc">
      <h1>Bonjour ${echapper(visiteur.prenom)}</h1>

      <p class="discret">
        Billet ${echapper(visiteur.refBillet)} —
        <span class="etiquette ${visiteur.statut}">
          ${echapper(S.vue.statuts[visiteur.statut].libelle)}
        </span>
      </p>

      <h2>Avant de rejoindre la file</h2>

      <label class="case">
        <input type="checkbox" id="cgu">

        <span>
          J'accepte les conditions d'utilisation de la file virtuelle.
        </span>
      </label>

      <label class="case">
        <input type="checkbox" id="decharge">

        <span>
          J'ai lu la décharge de responsabilité : la Salle du Temps
          soumet le corps à une pesanteur multipliée,
          avec une accélération de plusieurs G.
        </span>
      </label>

      <h2>Votre aptitude</h2>

      <p class="discret">
        Répondez vous-même. Nous ne conservons que « apte »
        ou « non apte » : aucune information de santé
        n'entre dans le système.
      </p>

      <div class="ligne">
        <button
          class="principal"
          data-action="apte"
          data-apte="1"
        >
          Je suis apte
        </button>

        <button
          class="sobre"
          data-action="apte"
          data-apte="0"
        >
          Je ne le suis pas
        </button>
      </div>
    </div>
  `;
}

function ecranAttraction(visiteur) {
  const code = visiteur.statut;
  const a = S.vue.attente[code];
  const i = S.vue.inscriptions[code];
  const garantie = S.vue.statuts[code].garantieMin;

  const onglets = barreOnglets([
    ['attente', 'Attente'],
    ['infos', 'Infos'],
    ['regles', 'Règles'],
    ['profil', 'Mes données'],
  ]);

  if (S.onglet === 'infos') {
    return onglets + blocInfos();
  }

  if (S.onglet === 'regles') {
    return onglets + blocRegles();
  }

  if (S.onglet === 'profil') {
    return onglets + blocProfil(visiteur);
  }

  return `
    ${onglets}

    <div class="bloc accent">
      <h1>${echapper(S.vue.file.nom)}</h1>

      <p class="discret">
        Votre statut :
        <span class="etiquette ${code}">
          ${echapper(S.vue.statuts[code].libelle)}
        </span>

        ${garantie ? ` — attente garantie à ${garantie} min` : ''}
      </p>

      <div class="fourchette">
        ${a.basse}–${a.haute}
        <span class="discret">minutes d'attente</span>
      </div>

      ${
        a.elargie
          ? '<p class="discret">Fourchette élargie : un incident récent perturbe le débit.</p>'
          : ''
      }

      <p class="discret">
        ${a.devant}
        personne(s) devant vous si vous vous inscrivez maintenant.
      </p>

      ${
        i.ouvert
          ? `
            <p class="discret">
              Inscriptions ouvertes jusqu'à ${i.heureLimite}.
            </p>

            <button
              class="principal large"
              data-action="rejoindre"
            >
              Rejoindre la file
            </button>
          `
          : `
            <div class="message info">
              ${echapper(i.motif)}
            </div>
          `
      }
    </div>

    ${blocEtatFile()}
  `;
}

function ecranMonTicket(ticket) {
  const onglets = barreOnglets([
    ['attente', 'Ma position'],
    ['infos', 'Infos'],
    ['regles', 'Règles'],
    ['profil', 'Mes données'],
  ]);

  if (S.onglet === 'infos') {
    return onglets + blocInfos();
  }

  if (S.onglet === 'regles') {
    return onglets + blocRegles();
  }

  if (S.onglet === 'profil') {
    return onglets + blocProfil(S.moi.visiteur);
  }

  return `
    ${onglets}

    <div class="bloc">
      <h3>Votre position dans la file</h3>

      <div class="chiffre">
        ${ticket.position}
        <span class="unite">
          / ${S.vue.compteurs.enAttente}
        </span>
      </div>

      <p class="discret">
        Ticket ${echapper(ticket.id)}
        — inscrit à ${ticket.heureInscription}
        —
        <span class="etiquette ${ticket.statut}">
          ${echapper(ticket.libelleStatut)}
        </span>
      </p>
    </div>

    <div class="bloc accent">
      <h3>Attente estimée</h3>

      <div class="fourchette">
        ${ticket.estimation.basse}–${ticket.estimation.haute}
        <span class="discret">min</span>
      </div>

      <p class="discret">
        Passage prévu vers ${ticket.heurePrevisionnelle}.
      </p>

      ${
        ticket.resteGarantieMin !== null
          ? `<p class="discret">
              Garantie : ${ticket.resteGarantieMin}
              min restantes sur votre engagement.
            </p>`
          : ''
      }

      ${
        ticket.geleParPause
          ? '<div class="message info">Attraction en pause. Votre place est conservée et vos compteurs sont gelés.</div>'
          : ''
      }

      ${
        ticket.avertiFinJournee
          ? '<div class="message erreur">Votre passage avant la fermeture n\'est pas assuré. Vous pouvez vous désister sans pénalité.</div>'
          : ''
      }
    </div>

    <div class="bloc">
      <h3>Votre code d'accès</h3>

      <p class="discret">
        Il s'activera automatiquement dès que nous vous convoquerons.
        Inutile de rester sur l'application :
        nous vous envoyons un e-mail.
      </p>

      <button
        class="sobre large"
        data-action="desister"
      >
        Quitter la file
      </button>
    </div>

    ${blocEtatFile()}
  `;
}

function ecranConvocation(ticket) {
  const restant = compteARebours(ticket);
  const urgence = restant.sec <= 120 ? 'urgence' : '';

  return `
    <div class="convocation">
      <div class="contenu">

        <h1>C'est votre tour</h1>

        <p class="discret">
          Présentez-vous à l'entrée de la Salle du Temps.
        </p>

        <div class="chiffre ${urgence}">
          ${restant.texte}
          <span class="unite"> avant expiration</span>
        </div>

        ${
          restant.grace
            ? '<div class="message info">Délai dépassé — vous êtes dans le délai de grâce.</div>'
            : ''
        }

        ${
          ticket.geleParPause
            ? '<div class="message info">Compteur gelé : attraction en pause.</div>'
            : ''
        }

        <div class="bloc">
          <div id="qr"></div>

          <p
            class="code-secours"
            id="code-secours"
          >
            Préparation du code…
          </p>

          <p class="discret">
            Code renouvelé toutes les 30 secondes.
            Une capture d'écran ne fonctionne pas.
          </p>
        </div>

        <p class="discret">
          L'agent contrôlera aussi votre pièce d'identité.
        </p>

        <button
          class="sobre"
          data-action="desister"
        >
          Je ne peux pas venir
        </button>

      </div>
    </div>
  `;
}

function ecranFinParcours(ticket) {
  const textes = {
    ENTRE: [
      'Bon voyage dans le temps',
      'Votre entrée a été validée. Merci d\'avoir utilisé la file virtuelle.',
    ],

    EXPIRE: [
      'Convocation expirée',
      'Vous ne vous êtes pas présenté à temps. Vous pouvez vous réinscrire en fin de file.',
    ],

    ANNULE: [
      'Vous avez quitté la file',
      'Votre place a été libérée. Vous pouvez vous réinscrire quand vous voulez.',
    ],

    RETIRE: [
      'Ticket retiré par un agent',
      ticket.motif || 'Un agent a retiré votre ticket.',
    ],

    PURGE: [
      'Attraction fermée',
      ticket.motif || 'L\'attraction a fermé pour la journée.',
    ],
  }[ticket.etat] || ['Parcours terminé', ''];

  return `
    <div class="bloc">
      <h1>${echapper(textes[0])}</h1>

      <p>${echapper(textes[1])}</p>

      <button
        class="principal"
        data-action="rejoindre"
      >
        Se réinscrire
      </button>

      <button
        class="sobre"
        data-action="onglet"
        data-onglet="profil"
      >
        Mes données
      </button>
    </div>

    ${blocEtatFile()}
  `;
}

/* --- Blocs partagés de l'interface visiteur ------------------------------ */

function blocEtatFile() {
  const v = S.vue;

  const pct = Math.min(
    100,
    Math.round(
      (v.capteur.occupation / v.capteur.capacite) * 100
    )
  );

  return `
    <div class="bloc">
      <h3>L'attraction en direct</h3>

      <div class="indicateurs">

        <div class="indicateur">
          <div class="valeur">${v.compteurs.enAttente}</div>
          <div class="titre">dans la file</div>
        </div>

        <div class="indicateur">
          <div class="valeur">${v.compteurs.entres}</div>
          <div class="titre">entrés aujourd'hui</div>
        </div>

        <div class="indicateur">
          <div class="valeur">
            ${v.cycle.minutesAvantProchain}
            <span class="titre"> min</span>
          </div>

          <div class="titre">
            avant le prochain cycle
          </div>
        </div>

      </div>

      <div class="jauge ${pct >= 90 ? 'pleine' : ''}">
        <span style="width:${pct}%"></span>
      </div>

      <small>
        Salle d'attente :
        ${v.capteur.occupation}
        personnes sur
        ${v.capteur.capacite}
        places
        (source ${v.capteur.source}).
      </small>
    </div>
  `;
}

function blocInfos() {
  const v = S.vue;

  return `
    <div class="bloc">

      <h3>Horaires</h3>

      <p>
        Inscriptions dès ${v.file.ouvertureFile}.
        Exploitation de ${v.file.debutExploitation}
        à ${v.file.finExploitation}.
      </p>

      <h3>Capacité</h3>

      <p>
        ${v.cycle.placesParCycle} visiteurs par cycle,
        soit ${v.cycle.debitNominal} personnes par heure.
        La salle d'attente accueille
        ${v.capteur.capacite} personnes au maximum.
      </p>

      <h3>Accès</h3>

      <p>
        La Salle du Temps soumet le corps à une forte pesanteur.
        L'accès est refusé aux personnes ayant déclaré ne pas être aptes.
      </p>

    </div>
  `;
}

function blocRegles() {
  const v = S.vue;

  const lignes = Object.entries(v.statuts)
    .map(([code, s]) => `
      <tr>
        <td>
          <span class="etiquette ${code}">
            ${echapper(s.libelle)}
          </span>
        </td>

        <td>
          ${
            s.garantieMin === null
              ? 'Ordre d\'arrivée'
              : s.garantieMin === 0
                ? 'Accès immédiat'
                : `${s.garantieMin} min garanties`
          }
        </td>

        <td class="discret">
          ${Math.round(s.quotaCycle * 100)}
          % des places au maximum
          ${
            s.partMin
              ? `, ${Math.round(s.partMin * 100)} % réservées`
              : ''
          }
        </td>
      </tr>
    `)
    .join('');

  return `
    <div class="bloc">

      <h3>Les trois statuts</h3>

      <table>
        <tbody>
          ${lignes}
        </tbody>
      </table>

      <h3>Ce que nous garantissons</h3>

      <p>
        Votre rang d'arrivée ne change jamais.
        Aucun agent ne peut ajouter quelqu'un devant vous :
        la file ne s'alimente que par les inscriptions des visiteurs.
      </p>

      <p>
        En cas d'incident, vos compteurs sont gelés et votre place est conservée.
        Nous ne promettons jamais un passage impossible avant
        ${v.file.finExploitation}.
      </p>

    </div>
  `;
}

function blocProfil(visiteur) {
  const messages = (S.moi.messages || []).slice(0, 8);

  return `
    <div class="bloc">

      <h3>Ce que nous conservons</h3>

      <p class="discret">
        ${echapper(visiteur.email)}
        ·
        ${echapper(visiteur.prenom)}
        ${echapper(visiteur.initiale)}.
        · billet
        ${echapper(visiteur.refBillet)}
        · aptitude :
        ${visiteur.apte ? 'apte' : 'non apte'}
      </p>

      <p class="discret">
        Tout est effacé le lendemain, sauf la preuve de consentement
        (3 ans) et le journal des actions des opérateurs (12 mois).
      </p>

      <div class="ligne">

        <button
          class="sobre"
          data-action="exporter"
        >
          Exporter mes données
        </button>

        <button
          class="danger"
          data-action="effacer"
        >
          Effacer mes données
        </button>

      </div>
    </div>

    <div class="bloc">

      <h3>Mes notifications</h3>

      <button
        class="sobre"
        data-action="messages"
      >
        Actualiser
      </button>

      ${
        messages.length
          ? messages
              .map(
                (m) => `
                  <p>
                    <strong>${echapper(m.sujet)}</strong>
                    <br>
                    <small>${echapper(m.corps)}</small>
                  </p>
                `
              )
              .join('')
          : '<p class="vide-liste">Aucun message pour le moment.</p>'
      }

    </div>
  `;
}

/* ========================================================= ECRAN AGENT === */

function ecranAgent() {
  if (!S.vue) {
    return '<p class="chargement">Connexion au flux temps réel…</p>';
  }

  const onglets = barreOnglets([
    ['scan', 'Scan'],
    ['file', 'File'],
    ['incidents', 'Incidents'],
  ]);

  if (S.onglet === 'file') {
    return onglets + blocFileAgent();
  }

  if (S.onglet === 'incidents') {
    return onglets + blocIncidents();
  }

  return onglets + blocScan();
}

/* -------------------------------------------------------------------------
   SCANNER QR
   -------------------------------------------------------------------------
   html5-qrcode utilise un conteneur <div> et crée lui-même les éléments
   nécessaires pour afficher la caméra.
   ------------------------------------------------------------------------- */

function blocScan() {
  const s = S.scan;

  return `
    ${
      s
        ? `
          <div class="verdict ${s.verdict}">

            <div class="mot">
              ${
                s.verdict === 'ACCEPTE'
                  ? 'Entrée autorisée'
                  : 'Entrée refusée'
              }
            </div>

            ${
              s.visiteur
                ? `
                  <p>
                    ${echapper(s.visiteur.prenom)}
                    ${echapper(s.visiteur.initiale)}. —
                    ${echapper(
                      S.vue?.statuts?.[s.visiteur.statut]?.libelle ||
                      s.visiteur.statut
                    )}.
                    Contrôlez la pièce d'identité avant de laisser entrer.
                  </p>
                `
                : ''
            }

            ${
              s.motif
                ? `<p>${echapper(s.motif)}</p>`
                : ''
            }

          </div>
        `
        : ''
    }

    <div class="bloc">

      <h3>Scanner un code</h3>

      <label for="jeton">
        Code du visiteur (caméra ou saisie manuelle)
      </label>

      <input
        id="jeton"
        type="text"
        placeholder="tk_xxxxxxxx.xxxxxxx.xxxxxxxxxxxx"
        autocomplete="off"
      >

      <div class="ligne">

        <button
          class="principal"
          data-action="scanner"
        >
          Valider l'entrée
        </button>

        <button
          class="sobre"
          data-action="camera"
        >
          Utiliser la caméra
        </button>

      </div>

      <!--
        IMPORTANT :
        ce doit être un DIV et non un VIDEO.
        html5-qrcode crée et contrôle lui-même la vidéo.
      -->
      <div
        id="video"
        style="
          display:none;
          width:100%;
          margin-top:10px;
        "
      ></div>

      <p class="discret">
        Le code tourne toutes les 30 secondes :
        une capture d'écran est refusée.
      </p>

    </div>
  `;
}

function blocFileAgent() {
  const lignes = (S.agent?.file || [])
    .map(
      (t) => `
        <tr>

          <td>${t.position}</td>

          <td>
            <span class="etiquette ${t.statut}">
              ${echapper(t.libelleStatut)}
            </span>
          </td>

          <td>${echapper(t.visiteur)}</td>

          <td class="discret">
            ${t.heureInscription}
          </td>

          <td>
            ${
              t.etat === 'CONVOQUE'
                ? `
                  <span class="etiquette CONVOQUE">
                    convoqué · ${t.resteConvocationSec}s
                  </span>
                `
                : 'en attente'
            }
          </td>

          <td class="discret">
            ${
              t.resteGarantieMin === null
                ? '—'
                : `${t.resteGarantieMin} min`
            }
          </td>

          <td>
            <button
              class="sobre"
              data-action="retirer"
              data-id="${t.id}"
            >
              Retirer
            </button>
          </td>

        </tr>
      `
    )
    .join('');

  return `
    <div class="bloc">

      <h3>File en cours</h3>

      <p class="discret">
        Aucun bouton d'ajout : la file ne s'alimente
        que par les inscriptions des visiteurs.
      </p>

      <div class="defilant">

        <table>

          <thead>
            <tr>
              <th>#</th>
              <th>Statut</th>
              <th>Visiteur</th>
              <th>Inscrit</th>
              <th>État</th>
              <th>Garantie</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            ${
              lignes ||
              '<tr><td colspan="7" class="vide-liste">File vide.</td></tr>'
            }
          </tbody>

        </table>

      </div>

    </div>
  `;
}

function blocIncidents() {
  const enPause = S.vue?.file.etat === 'EN_PAUSE';
  const fermee = S.vue?.file.etat === 'PURGEE';

  return `
    <div class="bloc">

      <h3>Exploitation</h3>

      <label for="motif">
        Motif (obligatoire et tracé)
      </label>

      <input
        id="motif"
        type="text"
        placeholder="Panne du sas, évacuation, maintenance…"
      >

      <div class="ligne">

        ${
          enPause
            ? `
              <button
                class="principal"
                data-action="reprendre"
              >
                Reprendre l'exploitation
              </button>
            `
            : `
              <button
                class="sobre"
                data-action="pause"
              >
                Mettre en pause
              </button>
            `
        }

        <button
          class="sobre"
          data-action="incident"
        >
          Déclarer un incident
        </button>

        ${
          fermee
            ? `
              <button
                class="sobre"
                data-action="rouvrir"
              >
                Rouvrir la file
              </button>
            `
            : `
              <button
                class="danger"
                data-action="purger"
              >
                Purger la file
              </button>
            `
        }

      </div>

      <p class="discret">
        La pause gèle tous les compteurs et prévient les visiteurs.
        La purge demande une double confirmation et annule tous les tickets.
      </p>

    </div>

    <div class="bloc">

      <h3>Derniers scans</h3>

      <button
        class="sobre"
        data-action="incidents-charger"
      >
        Actualiser
      </button>

      <div class="defilant">

        <table>
          <tbody>

            ${
              (S.incidents?.scans || [])
                .map(
                  (s) => `
                    <tr>
                      <td>${echapper(s.verdict)}</td>
                      <td class="discret">
                        ${echapper(s.motif || '')}
                      </td>
                      <td class="discret">
                        ${echapper(s.ticketId || '')}
                      </td>
                    </tr>
                  `
                )
                .join('') ||
              '<tr><td class="vide-liste">Aucun scan enregistré.</td></tr>'
            }

          </tbody>
        </table>

      </div>
    </div>
  `;
}

/* ========================================================= ECRAN ADMIN === */

function ecranAdmin() {
  if (!S.vue) {
    return '<p class="chargement">Connexion au flux temps réel…</p>';
  }

  const onglets = barreOnglets([
    ['apercu', 'Vue d\'ensemble'],
    ['attentes', 'Temps d\'attente'],
    ['affluence', 'Affluence'],
    ['regles', 'Règles'],
    ['audit', 'Audit'],
    ['file', 'File'],
  ]);

  if (!S.admin) {
    return onglets + '<p class="chargement">Chargement…</p>';
  }

  if (S.onglet === 'attentes') {
    return onglets + blocAttentes();
  }

  if (S.onglet === 'affluence') {
    return onglets + blocAffluence();
  }

  if (S.onglet === 'regles') {
    return onglets + blocReglesAdmin();
  }

  if (S.onglet === 'audit') {
    return onglets + blocAudit();
  }

  if (S.onglet === 'file') {
    return onglets + blocFileAgent();
  }

  return onglets + blocApercu();
}

function blocApercu() {
  const m = S.admin.metriques;

  const ind = (valeur, titre) => `
    <div class="indicateur">
      <div class="valeur">${valeur}</div>
      <div class="titre">${titre}</div>
    </div>
  `;

  return `
    <div class="indicateurs">

      ${ind(m.totaux.enAttente, 'dans la file')}

      ${ind(m.totaux.entres, 'entrées validées')}

      ${ind(
        `${m.remplissage.attractionPct} %`,
        'remplissage attraction'
      )}

      ${ind(
        `${m.remplissage.sallePct} %`,
        'remplissage salle'
      )}

      ${ind(
        `${m.garantieSaiyanPct} %`,
        'garantie Saiyan tenue'
      )}

      ${ind(
        `${m.ecartAnnonceReelPct} %`,
        'écart annoncé / réel'
      )}

      ${ind(
        `${m.absences.tauxPct} %`,
        'absences à la convocation'
      )}

      ${ind(
        m.finDeJournee.ticketsNonServis,
        'non servis à la fermeture'
      )}

      ${ind(
        `${m.finDeJournee.tauxDesistementPct} %`,
        'désistements'
      )}

      ${ind(
        `${m.incidents.dureeCumuleeMin} min`,
        `indisponibilité (${m.incidents.nombre} incidents)`
      )}

    </div>

    <div class="bloc">

      <h3>Répartition des passages</h3>

      <table>
        <tbody>

          ${
            Object.entries(m.repartitionPassages)
              .map(
                ([code, n]) => `
                  <tr>
                    <td>
                      <span class="etiquette ${code}">
                        ${echapper(
                          S.vue.statuts[code]?.libelle || code
                        )}
                      </span>
                    </td>

                    <td>
                      ${n} passage(s)
                    </td>
                  </tr>
                `
              )
              .join('') ||
            '<tr><td class="vide-liste">Aucun passage.</td></tr>'
          }

        </tbody>
      </table>

    </div>
  `;
}

function blocAttentes() {
  const m = S.admin.metriques;

  return `
    <div class="bloc">

      <h3>Temps d'attente par statut</h3>

      <table>

        <thead>
          <tr>
            <th>Statut</th>
            <th>Actuel</th>
            <th>Moyenne vécue</th>
            <th>90e centile</th>
            <th>Passages</th>
          </tr>
        </thead>

        <tbody>

          ${
            Object.entries(m.attentes)
              .map(
                ([code, a]) => `
                  <tr>

                    <td>
                      <span class="etiquette ${code}">
                        ${echapper(a.libelle)}
                      </span>
                    </td>

                    <td>${a.actuelMin} min</td>

                    <td>${a.moyenneMin} min</td>

                    <td>${a.p90Min} min</td>

                    <td>${a.passages}</td>

                  </tr>
                `
              )
              .join('')
          }

        </tbody>

      </table>

      <p class="discret">
        L'écart moyen entre l'attente annoncée à l'inscription
        et l'attente réellement vécue est de
        ${m.ecartAnnonceReelPct} %
        (objectif : moins de 10 %).
      </p>

    </div>
  `;
}

function blocAffluence() {
  const v = S.vue;

  const pct = Math.min(
    100,
    Math.round(
      (v.capteur.occupation / v.capteur.capacite) * 100
    )
  );

  return `
    <div class="bloc">

      <h3>Capteur de la salle d'attente</h3>

      <div class="chiffre">
        ${v.capteur.occupation}
        <span class="unite">
          / ${v.capteur.capacite} places
        </span>
      </div>

      <div class="jauge ${pct >= 90 ? 'pleine' : ''}">
        <span style="width:${pct}%"></span>
      </div>

      <p class="discret">
        Source : ${echapper(v.capteur.source)}
        · relevé il y a ${v.capteur.age ?? '?'} s
        ${
          v.capteur.erreur
            ? ` · erreur : ${echapper(v.capteur.erreur)}`
            : ''
        }
      </p>

      <label for="occupation">
        Forcer l'occupation
        (démonstration ; vide = capteur réel)
      </label>

      <input
        id="occupation"
        type="number"
        min="0"
        placeholder="ex. 48"
      >

      <button
        class="sobre"
        data-action="capteur"
      >
        Appliquer
      </button>

    </div>

    <div class="bloc">

      <h3>Cycle en cours</h3>

      <p>
        Cycle n°${v.cycle.index}
        —
        ${v.cycle.placesConsommees}
        /
        ${v.cycle.placesParCycle}
        places consommées,
        prochain cycle dans
        ${v.cycle.minutesAvantProchain} min.
      </p>

      <p class="discret">
        Débit nominal :
        ${v.cycle.debitNominal}
        visiteurs par heure.
      </p>

    </div>
  `;
}

/** Champs de réglage exposés au paramétrage à chaud. */
const CHAMPS_REGLES = [
  ['dureeCycleMin', 'Durée d\'un cycle (min)'],
  ['placesParCycle', 'Places par cycle'],
  ['capaciteSalleAttente', 'Capacité salle d\'attente'],
  ['delaiConvocationSec', 'Délai de convocation (s)'],
  ['delaiGraceSec', 'Délai de grâce (s)'],
  ['rappelAvantFinSec', 'Rappel avant expiration (s)'],
  ['margeSecuriteMin', 'Marge de sécurité (min)'],
  ['seuilVigilanceMin', 'Seuil de vigilance (min)'],
  ['ouvertureFile', 'Ouverture des inscriptions (min depuis minuit)'],
  ['debutExploitation', 'Début d\'exploitation'],
  ['finExploitation', 'Fin d\'exploitation'],
  ['periodeTickMs', 'Période de l\'ordonnanceur (ms)'],
  ['capteurUrl', 'URL du capteur'],
];

function blocReglesAdmin() {
  const r = S.admin.regles;

  const champs = CHAMPS_REGLES
    .map(
      ([cle, libelle]) => `
        <div>

          <label for="r-${cle}">
            ${libelle}
          </label>

          <input
            id="r-${cle}"
            data-regle="${cle}"
            value="${echapper(r[cle])}"
          >

        </div>
      `
    )
    .join('');

  const quotas = Object.entries(r.statuts)
    .map(
      ([code, s]) => `
        <div>

          <label for="q-${code}">
            ${echapper(s.libelle)}
            — quota max par cycle (%)
          </label>

          <input
            id="q-${code}"
            data-quota="${code}"
            type="number"
            value="${Math.round(s.quotaCycle * 100)}"
          >

        </div>
      `
    )
    .join('');

  return `
    <div class="bloc">

      <h3>Paramètres d'exploitation</h3>

      <p class="discret">
        Toute modification est appliquée immédiatement,
        sans redémarrage, et tracée dans l'audit.
      </p>

      ${champs}

      ${quotas}

      <button
        class="principal"
        data-action="enregistrer-regles"
      >
        Enregistrer
      </button>

    </div>

    <div class="bloc">

      <h3>Horloge de démonstration</h3>

      <p class="discret">
        Pour montrer l'ouverture de 8h,
        un cycle complet ou la fermeture de 19h
        sans attendre la journée entière.
      </p>

      <div class="ligne">

        <div>
          <label for="heure">Heure</label>
          <input
            id="heure"
            type="time"
            value="${S.vue.horloge.heure}"
          >
        </div>

        <div>
          <label for="vitesse">Vitesse</label>
          <input
            id="vitesse"
            type="number"
            value="${S.vue.horloge.vitesse}"
          >
        </div>

      </div>

      <div class="ligne">

        <button
          class="sobre"
          data-action="horloge"
        >
          Appliquer
        </button>

        <button
          class="sobre"
          data-action="horloge-reel"
        >
          Revenir au temps réel
        </button>

      </div>

    </div>

    <div class="bloc">

      <h3>Jeu de données</h3>

      <label for="nombre">
        Nombre de visiteurs fictifs à inscrire
      </label>

      <input
        id="nombre"
        type="number"
        value="24"
      >

      <button
        class="sobre"
        data-action="seed"
      >
        Peupler la file
      </button>

    </div>
  `;
}

function blocAudit() {
  const lignes = S.admin.audit
    .map(
      (a) => `
        <tr>

          <td class="discret">
            ${new Date(a.ts).toLocaleTimeString('fr-FR')}
          </td>

          <td>
            ${echapper(a.acteur)}
          </td>

          <td>
            ${echapper(a.action)}
          </td>

          <td class="discret">
            ${echapper(a.details)}
          </td>

        </tr>
      `
    )
    .join('');

  return `
    <div class="bloc">

      <h3>Journal d'audit</h3>

      <p class="discret">
        Toutes les actions des opérateurs,
        conservées 12 mois.
      </p>

      <div class="defilant">

        <table>

          <thead>
            <tr>
              <th>Heure</th>
              <th>Acteur</th>
              <th>Action</th>
              <th>Détail</th>
            </tr>
          </thead>

          <tbody>
            ${
              lignes ||
              '<tr><td colspan="4" class="vide-liste">Aucune action.</td></tr>'
            }
          </tbody>

        </table>

      </div>
    </div>
  `;
}

/* ------------------------------------------------------------- Onglets --- */

function barreOnglets(liste) {
  return `
    <nav class="onglets">
      ${liste
        .map(
          ([cle, libelle]) => `
            <button
              data-action="onglet"
              data-onglet="${cle}"
              aria-selected="${S.onglet === cle}"
            >
              ${libelle}
            </button>
          `
        )
        .join('')}
    </nav>
  `;
}

/* --------------------------------------------------- Compte à rebours ---- */

function compteARebours(ticket) {
  const ecoule = ticket.geleParPause
    ? 0
    : Math.floor(
        (Date.now() - S.recuA) / 1000
      );

  const reste = Math.max(
    0,
    ticket.resteSec - ecoule
  );

  const resteGrace = Math.max(
    0,
    ticket.resteGraceSec - ecoule
  );

  const sec = reste > 0
    ? reste
    : resteGrace;

  const m = Math.floor(sec / 60);
  const s = sec % 60;

  return {
    sec,
    grace: reste === 0 && resteGrace > 0,
    texte: `${m}:${String(s).padStart(2, '0')}`,
  };
}

/* --------------------------------------------------------- QR code ------- */

let cacheJeton = {
  jeton: null,
  expireA: 0,
};

async function dessinerQr() {
  const boite = document.getElementById('qr');

  if (
    !boite ||
    !S.moi?.ticket ||
    S.moi.ticket.etat !== 'CONVOQUE'
  ) {
    cacheJeton = {
      jeton: null,
      expireA: 0,
    };

    return;
  }

  try {
    if (
      !cacheJeton.jeton ||
      Date.now() >= cacheJeton.expireA
    ) {
      const r = await api(
        'GET',
        `/api/tickets/${S.moi.ticket.id}/qr`
      );

      cacheJeton = {
        jeton: r.jeton,
        expireA:
          Date.now() +
          Math.max(1, r.expireDans - 1) * 1000,
      };
    }

    boite.innerHTML = '';

    if (window.QRCode) {
      new window.QRCode(boite, {
        text: cacheJeton.jeton,
        width: 220,
        height: 220,
      });
    } else {
      boite.textContent =
        'Code à saisir manuellement par l\'agent :';
    }

    const secours =
      document.getElementById('code-secours');

    if (secours) {
      secours.textContent =
        cacheJeton.jeton;
    }
  } catch {
    // Le ticket n'est plus convoqué :
    // le prochain rendu corrigera l'affichage.
  }
}

/* ------------------------------------------------------------- Actions --- */

function brancherActions(racine) {
  racine
    .querySelectorAll('[data-action]')
    .forEach((el) => {
      el.addEventListener('click', () => {
        executer(
          el.dataset.action,
          el.dataset
        );
      });
    });
}

async function executer(action, data) {
  const valeur = (id) =>
    document.getElementById(id)?.value?.trim() ?? '';

  switch (action) {

    case 'deconnexion':
      return seDeconnecter();

    case 'onglet':
      S.onglet = data.onglet;
      return rendre();

    case 'lien': {
      try {
        const r = await api(
          'POST',
          '/api/auth/magic-link',
          {
            email: valeur('email'),
          }
        );

        const v = await api(
          'POST',
          '/api/auth/verify',
          {
            jeton: r.jeton,
          }
        );

        ouvrirSession(
          v.session,
          'visiteur'
        );

        S.onglet = 'attente';

        return agir(
          async () => v,
          `Connecté. Un e-mail de confirmation a été envoyé à ${v.visiteur.email}.`
        );
      } catch (e) {
        return annoncer(
          e.message,
          'erreur'
        );
      }
    }

    case 'backoffice': {
      try {
        const r = await api(
          'POST',
          '/api/auth/backoffice/login',
          {
            code: valeur('code'),
          }
        );

        ouvrirSession(
          r.session,
          r.role
        );

        S.onglet =
          r.role === 'admin'
            ? 'apercu'
            : 'scan';

        return rafraichir();
      } catch (e) {
        return annoncer(
          e.message,
          'erreur'
        );
      }
    }

    case 'apte': {
      const apte =
        data.apte === '1';

      const cgu =
        document.getElementById('cgu')?.checked;

      const decharge =
        document.getElementById('decharge')?.checked;

      if (!cgu || !decharge) {
        return annoncer(
          'Acceptez les conditions et la décharge pour continuer.',
          'erreur'
        );
      }

      return agir(
        async () => {
          await api(
            'POST',
            '/api/me/consents',
            {
              cgu,
              decharge,
            }
          );

          await api(
            'POST',
            '/api/me/eligibility',
            {
              apte,
            }
          );
        }
      );
    }

    case 'revenir-aptitude':
      return agir(
        () =>
          api(
            'POST',
            '/api/me/eligibility',
            {
              apte: true,
            }
          )
      );

    case 'rejoindre':
      return agir(
        () =>
          api(
            'POST',
            `/api/queues/${FILE}/tickets`
          ),
        'Vous êtes dans la file.'
      );

    case 'desister': {
      if (
        !confirm(
          'Quitter la file ? Cette action est définitive et libère votre place.'
        )
      ) {
        return;
      }

      return agir(
        () =>
          api(
            'DELETE',
            `/api/tickets/${S.moi.ticket.id}`
          ),
        'Vous avez quitté la file.'
      );
    }

    case 'exporter': {
      const donnees =
        await api(
          'GET',
          '/api/me/export'
        );

      const url =
        URL.createObjectURL(
          new Blob(
            [
              JSON.stringify(
                donnees,
                null,
                2
              ),
            ],
            {
              type: 'application/json',
            }
          )
        );

      const a =
        document.createElement('a');

      a.href = url;
      a.download =
        'mes-donnees-waitless.json';

      a.click();

      URL.revokeObjectURL(url);

      return annoncer(
        'Export téléchargé.',
        'succes'
      );
    }

    case 'effacer': {
      if (
        !confirm(
          'Effacer définitivement vos données ? Votre ticket sera annulé.'
        )
      ) {
        return;
      }

      await agir(
        () =>
          api(
            'DELETE',
            '/api/me'
          )
      );

      return seDeconnecter();
    }

    case 'messages': {
      const r =
        await api(
          'GET',
          '/api/me/messages'
        );

      S.moi.messages =
        r.messages;

      return rendre();
    }

    /* ------------------------------------------------ Scanner manuel --- */

    case 'scanner': {
      try {
        const jeton =
          valeur('jeton');

        if (!jeton) {
          return annoncer(
            'Saisissez ou scannez un code.',
            'erreur'
          );
        }

        S.scan =
          await api(
            'POST',
            '/api/agent/scans',
            {
              jeton,
            }
          );

        const champ =
          document.getElementById('jeton');

        if (champ) {
          champ.value = '';
        }

        return rafraichir();

      } catch (e) {
        return annoncer(
          e.message,
          'erreur'
        );
      }
    }

    /* ------------------------------------------------ Scanner caméra --- */

    case 'camera':
      return scannerAvecCamera();

    case 'retirer': {
      const motif =
        prompt(
          'Motif du retrait (obligatoire) :'
        );

      if (!motif) return;

      return agir(
        () =>
          api(
            'DELETE',
            `/api/agent/tickets/${data.id}?motif=${encodeURIComponent(motif)}`
          ),
        'Ticket retiré.'
      );
    }

    case 'pause':
      return agir(
        () =>
          api(
            'POST',
            `/api/agent/queues/${FILE}/pause`,
            {
              motif: valeur('motif'),
            }
          ),
        'File en pause, compteurs gelés.'
      );

    case 'reprendre':
      return agir(
        () =>
          api(
            'POST',
            `/api/agent/queues/${FILE}/resume`
          ),
        'Exploitation reprise.'
      );

    case 'purger': {
      if (
        !confirm(
          'Purger la file ? Tous les tickets seront annulés.'
        )
      ) {
        return;
      }

      if (
        prompt(
          'Tapez PURGER pour confirmer :'
        ) !== 'PURGER'
      ) {
        return;
      }

      return agir(
        () =>
          api(
            'POST',
            `/api/agent/queues/${FILE}/purge`,
            {
              motif: valeur('motif'),
              confirmation: 'PURGER',
            }
          ),
        'File purgée.'
      );
    }

    case 'rouvrir':
      return agir(
        () =>
          api(
            'POST',
            `/api/agent/queues/${FILE}/reopen`
          ),
        'File rouverte.'
      );

    case 'incident':
      return agir(
        () =>
          api(
            'POST',
            '/api/agent/incidents',
            {
              motif: valeur('motif'),
            }
          ),
        'Incident enregistré.'
      );

    case 'incidents-charger': {
      S.incidents =
        await api(
          'GET',
          '/api/agent/incidents'
        );

      return rendre();
    }

    case 'capteur':
      return agir(
        () =>
          api(
            'PUT',
            '/api/mock/sensors',
            {
              occupation:
                valeur('occupation') || null,
            }
          )
      );

    case 'enregistrer-regles': {
      const patch = {};

      document
        .querySelectorAll('[data-regle]')
        .forEach((i) => {
          patch[i.dataset.regle] =
            i.value;
        });

      const statuts = {};

      document
        .querySelectorAll('[data-quota]')
        .forEach((i) => {
          statuts[i.dataset.quota] = {
            quotaCycle:
              Number(i.value) / 100,
          };
        });

      patch.statuts =
        statuts;

      return agir(
        () =>
          api(
            'PUT',
            '/api/admin/config/rules',
            patch
          ),
        'Règles appliquées immédiatement.'
      );
    }

    case 'horloge':
      return agir(
        () =>
          api(
            'POST',
            '/api/admin/clock',
            {
              heure: valeur('heure'),
              vitesse:
                Number(
                  valeur('vitesse')
                ),
            }
          ),
        'Horloge réglée.'
      );

    case 'horloge-reel':
      return agir(
        () =>
          api(
            'POST',
            '/api/admin/clock',
            {
              reel: true,
            }
          ),
        'Retour au temps réel.'
      );

    case 'seed':
      return agir(
        () =>
          api(
            'POST',
            '/api/admin/seed',
            {
              nombre:
                Number(
                  valeur('nombre')
                ),
            }
          ),
        'File peuplée.'
      );
  }
}

/* ================================================== SCAN PAR LA CAMÉRA === */

/*
 * Instance du scanner html5-qrcode.
 *
 * IMPORTANT :
 * html5-qrcode doit être chargé AVANT app.js dans la page HTML :
 *
 * <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
 * <script src="/app.js" type="module"></script>
 */
let scannerQR = null;

async function scannerAvecCamera() {
  const zone =
    document.getElementById('video');

  if (!zone) {
    return annoncer(
      'Zone de caméra introuvable.',
      'erreur'
    );
  }

  /*
   * Vérification importante :
   * html5-qrcode doit être disponible dans window.
   */
  if (
    typeof window.Html5Qrcode !== 'function'
  ) {
    return annoncer(
      'Le scanner QR n’est pas chargé. Vérifiez que html5-qrcode est bien inclus dans la page.',
      'erreur'
    );
  }

  /*
   * Évite de créer plusieurs scanners si l'utilisateur
   * clique plusieurs fois sur le bouton.
   */
  if (scannerQR) {
    return;
  }

  zone.style.display = 'block';
  zone.innerHTML = '';

  if (!navigator.mediaDevices?.getUserMedia) {
    return annoncer(
      'Ce navigateur ne permet pas d’accéder à la caméra. Ouvrez la page dans un vrai navigateur Chrome, Edge ou Firefox.',
      'erreur'
    );
  }

  try {
    scannerQR =
      new window.Html5Qrcode(
        'video'
      );

    await scannerQR.start(
      {
        facingMode: 'environment',
      },

      {
        fps: 10,

        qrbox: {
          width: 250,
          height: 250,
        },

        aspectRatio: 1.0,
      },

      async (decodedText) => {
        console.log(
          'QR code détecté :',
          decodedText
        );

        /*
         * On évite plusieurs détections
         * du même QR.
         */
        const scanner =
          scannerQR;

        scannerQR = null;

        try {
          await scanner.stop();
        } catch (e) {
          console.warn(
            'Impossible d’arrêter proprement la caméra :',
            e
          );
        }

        try {
          scanner.clear();
        } catch (e) {
          console.warn(
            'Impossible de nettoyer le scanner :',
            e
          );
        }

        zone.style.display =
          'none';

        zone.innerHTML = '';

        const champ =
          document.getElementById(
            'jeton'
          );

        if (!champ) {
          return annoncer(
            'Champ du code introuvable.',
            'erreur'
          );
        }

        /*
         * Le QR contient directement le jeton.
         */
        champ.value =
          decodedText;

        /*
         * On utilise exactement le même traitement
         * que pour une saisie manuelle.
         */
        return executer(
          'scanner',
          {}
        );
      },

      /*
       * Cette fonction est appelée lorsqu'aucun QR
       * n'est trouvé dans l'image.
       *
       * On ne fait rien : html5-qrcode continue
       * automatiquement à analyser la caméra.
       */
      () => {}
    );

  } catch (e) {
    console.error(
      'Erreur caméra :',
      e
    );

    if (scannerQR) {
      try {
        await scannerQR.clear();
      } catch {
        // Rien à faire.
      }
    }

    scannerQR = null;

    zone.style.display =
      'none';

    zone.innerHTML = '';

    let message =
      'Impossible d’accéder à la caméra.';

    /*
     * Certains navigateurs renvoient directement
     * un DOMException. On regarde donc le nom
     * de l'erreur.
     */
    if (
      e?.name ===
      'NotAllowedError'
    ) {
      message =
        'L’accès à la caméra a été refusé. Autorisez la caméra dans les paramètres du navigateur.';
    } else if (
      e?.name ===
      'NotFoundError'
    ) {
      message =
        'Aucune caméra n’a été trouvée sur cet appareil.';
    } else if (
      e?.name ===
      'NotReadableError'
    ) {
      message =
        'La caméra est déjà utilisée par une autre application.';
    } else if (
      e?.name ===
      'OverconstrainedError'
    ) {
      /*
       * Si la caméra arrière demandée n'existe pas,
       * on retente avec n'importe quelle caméra.
       */
      console.warn(
        'Caméra arrière indisponible, nouvelle tentative.'
      );

      try {
        scannerQR =
          new window.Html5Qrcode(
            'video'
          );

        zone.style.display =
          'block';

        await scannerQR.start(
          {
            facingMode:
              'environment',
          },

          {
            fps: 10,

            qrbox: {
              width: 250,
              height: 250,
            },
          },

          async (decodedText) => {
            const scanner =
              scannerQR;

            scannerQR = null;

            try {
              await scanner.stop();
            } catch {}

            try {
              scanner.clear();
            } catch {}

            zone.style.display =
              'none';

            zone.innerHTML = '';

            const champ =
              document.getElementById(
                'jeton'
              );

            if (!champ) {
              return annoncer(
                'Champ du code introuvable.',
                'erreur'
              );
            }

            champ.value =
              decodedText;

            return executer(
              'scanner',
              {}
            );
          },

          () => {}
        );

        return;

      } catch (e2) {
        console.error(
          'Deuxième tentative caméra échouée :',
          e2
        );

        scannerQR = null;

        zone.style.display =
          'none';

        zone.innerHTML = '';

        message =
          'Impossible d’accéder à la caméra sur cet appareil.';
      }
    }

    annoncer(
      message,
      'erreur'
    );
  }
}

/* -------------------------------------------------------- Demarrage ------ */

/*
 * Connexion depuis un lien magique (?connexion=...)
 */
const params =
  new URLSearchParams(
    location.search
  );

if (params.get('connexion')) {
  api(
    'POST',
    '/api/auth/verify',
    {
      jeton:
        params.get('connexion'),
    }
  )
    .then((v) => {
      ouvrirSession(
        v.session,
        'visiteur'
      );

      history.replaceState(
        {},
        '',
        '/'
      );

      rafraichir();
    })
    .catch(() =>
      annoncer(
        'Lien invalide ou expiré.',
        'erreur'
      )
    );
}

ouvrirFlux();
rafraichir();

/*
 * Compte à rebours :
 * seul rafraîchissement à la seconde,
 * uniquement quand un ticket est convoqué.
 */
setInterval(() => {
  if (
    S.role === 'visiteur' &&
    S.moi?.ticket?.etat === 'CONVOQUE'
  ) {
    rendre();
  }
}, 1000);