# Waitless — La Salle du Temps

File d'attente virtuelle pour l'attraction « La Salle du Temps ». Les visiteurs
prennent leur place depuis leur téléphone, profitent du parc, et ne se déplacent
qu'au moment d'entrer.

Démonstrateur du cahier des charges v1.0 du 2 septembre 2026. Les 16 fonctions
du MVP (F-01 à F-16) et les 15 règles métier (RG-01 à RG-15) sont implémentées.

---

## Démarrer

Prérequis : **Node.js 18 ou plus**. Rien d'autre. Pas de `npm install`, pas de
base de données à installer, pas de Docker : le projet n'a **aucune dépendance**.

```bash
node seed.js --heure=10:00   # crée 24 visiteurs fictifs et règle l'horloge
node server.js               # démarre le serveur
```

Puis ouvrir **http://localhost:3000**.

| Pour entrer comme | Faire |
|---|---|
| Visiteur | saisir n'importe quel e-mail, la connexion est immédiate |
| Agent | « Accès équipe » → code `AGENT-2026` |
| Administrateur | « Accès équipe » → code `ADMIN-2026` |

`node seed.js` doit être lancé **serveur arrêté** (les deux processus écriraient
dans le même journal). Une fois le serveur démarré, le tableau de bord
administrateur propose le même peuplement en un clic.

Autres commandes :

```bash
node seed.js --reset         # efface la journée et repart de zéro
node seed.js --nombre=60     # 60 visiteurs
node --test test/*.test.js   # lance les 16 tests des règles métier
```

---

## Scénario de démonstration

L'horloge d'exploitation est pilotable depuis le tableau de bord
(onglet **Règles**). C'est ce qui permet de montrer une journée entière en cinq
minutes, sans attendre 19h00.

1. **Inscription.** Se connecter comme visiteur, accepter les conditions et la
   décharge, se déclarer apte, rejoindre la file. La fourchette d'attente et la
   position s'affichent et se mettent à jour en direct.
2. **Priorités.** Le jeu de données contient des Humains, des Saiyans et des
   Super Saiyans. Dans la console agent, onglet **File**, on voit l'ordre réel :
   les Super Saiyans passent devant, les Saiyans remontent quand leur garantie
   de 30 minutes approche, et une part des places reste réservée aux Humains.
3. **Convocation et scan.** Quand le visiteur est convoqué, son écran bascule en
   plein écran avec un compte à rebours et un QR code. Dans la console agent,
   scanner ce code : verdict immédiat. Rescanner le même code : refusé, usage
   unique. Attendre 30 secondes et rescanner un ancien code : refusé, il a tourné.
4. **Incident.** Console agent → **Incidents** → mettre en pause avec un motif.
   Tous les compteurs se figent côté visiteur, un message part, et la reprise
   restitue exactement le temps restant.
5. **Fin de journée.** Tableau de bord → **Règles** → régler l'horloge sur
   `18:40`. Les inscriptions se ferment d'elles-mêmes, statut par statut, et les
   derniers inscrits reçoivent l'avertissement de vigilance.
6. **Panne.** Tuer le serveur brutalement (`Ctrl+C`, ou `kill -9`), puis
   `node server.js`. La file, l'ordre, les rangs et les convocations en cours
   sont identiques : rien n'est perdu.
7. **Capteur.** Tableau de bord → **Affluence** → forcer l'occupation à 50.
   L'ordonnanceur cesse de convoquer tant que la salle est pleine.

---

## Architecture

```
waitless/
├── server.js               point d'entrée : charge le journal, monte l'API, lance le battement
├── seed.js                 jeu de données fictif en ligne de commande
├── src/
│   ├── config/rules.js     valeurs par défaut + bornes de validité des règles
│   ├── domain/             ← tout le métier, sans HTTP ni fichiers
│   │   ├── clock.js        horloge d'exploitation pilotable
│   │   ├── state.js        état + réducteur d'événements + gel des compteurs
│   │   ├── eventStore.js   journal append-only, reconstruction de l'état
│   │   ├── estimator.js    estimation itérative de l'attente
│   │   ├── scheduler.js    ordonnanceur : quotas, garanties, expirations
│   │   ├── commands.js     une commande par action, toutes les règles sont ici
│   │   └── qr.js           jeton rotatif signé
│   ├── api/                ← transport uniquement
│   │   ├── http.js         micro-serveur (routage, JSON, statique, SSE)
│   │   ├── auth.js         lien magique et sessions signées, sans stockage
│   │   ├── routes.js       les routes du chapitre 6
│   │   └── views.js        projections de lecture pour les trois interfaces
│   └── infra/              ← le monde extérieur, remplaçable
│       ├── mailer.js       notifications simulées
│       ├── sensor.js       lecture du capteur de salle depuis une URL
│       ├── billetterie.js  référentiel des statuts (simulé)
│       └── jeuDeDonnees.js peuplement de démonstration
├── public/                 interface web (HTML + CSS + JS, sans framework)
└── test/regles.test.js     16 tests, un par règle critique
```

La dépendance va toujours dans le même sens : `api → domain → (rien)`, et
`infra` est appelée par le domaine à travers des fonctions simples. Le domaine
ne connaît ni HTTP, ni le format du stockage, ni le navigateur. C'est ce qui
rend les règles testables sans démarrer le serveur.

### Trois décisions structurantes

**Journal d'événements plutôt qu'une table d'états.** Rien n'est écrasé : chaque
fait est ajouté en fin de fichier (`data/evenements-AAAA-MM-JJ.jsonl`), et l'état
est reconstruit en rejouant le journal au démarrage. RG-13 (« conservation de
l'ordre après panne ») n'est donc pas une fonctionnalité en plus : c'est une
conséquence du stockage. L'écriture est synchrone, pour qu'un événement accepté
soit réellement sur le disque avant la réponse.

**Séparation commandes / vues.** Les écritures passent par `commands.js`, qui
vérifie les règles et publie des événements. Les lectures passent par
`views.js`, qui projette l'état pour chaque interface. Aucune interface ne lit
l'état interne directement.

**Horloge d'exploitation injectée.** Le domaine ne lit jamais `Date.now()`. Il
demande l'heure à `clock.js`, qui peut être décalée et accélérée. Sans cela, il
serait impossible de tester la fermeture de 19h00 ou de démontrer un cycle
complet en soutenance.

---

## Traçabilité — fonctionnalités du MVP

| # | Fonctionnalité | Où |
|---|---|---|
| F-01 | Connexion par lien e-mail, consentement, décharge | `api/auth.js`, `commands.js: donnerConsentements` |
| F-02 | Aptitude auto-déclarée en statut dérivé | `commands.js: declarerAptitude` (stocke un booléen, jamais la réponse) |
| F-03 | Ouverture de la file et de l'exploitation | `commands.js: etatInscriptions`, `scheduler.js: ordonnancer` |
| F-04 | Inscription avec temps prévisionnel | `commands.js: rejoindreFile` + `estimator.js` |
| F-05 | Suivi temps réel (< 5 s) | flux SSE `routes.js`, battement `server.js` |
| F-06 | Fermeture automatique des inscriptions | `commands.js: etatInscriptions` |
| F-07 | Notification de vigilance de fin de journée | `scheduler.js: avertirFinDeJournee` |
| F-08 | Convocation avec délai et grâce | `scheduler.js: ordonnancer`, `expirerConvocations` |
| F-09 | Trois statuts et leurs quotas | `config/rules.js: statuts`, `scheduler.js` |
| F-10 | QR nominatif rotatif, usage unique et journalier | `domain/qr.js` |
| F-11 | Scan agent avec verdict < 1 s | `commands.js: scanner`, console agent |
| F-12 | Retrait, pause, reprise, purge avec motif | `commands.js` (`retirerTicket`, `mettreEnPause`, `reprendre`, `purger`) |
| F-13 | Conservation de l'ordre après incident ou panne | `domain/eventStore.js` |
| F-14 | Capteur de la salle d'attente | `infra/sensor.js`, plafond dans `scheduler.js: ordonnancer` |
| F-15 | Tableau de bord exploitant | `api/views.js: vueMetriques` |
| F-16 | Configuration des règles sans redéploiement | `config/rules.js: validerRegles`, `PUT /api/admin/config/rules` |

## Traçabilité — règles métier

| # | Règle | Où | Testée |
|---|---|---|---|
| RG-01 | Horaires d'ouverture et d'exploitation | `commands.js: etatInscriptions`, `scheduler.js` | oui |
| RG-02 | Session, consentement, aptitude, un seul ticket | `commands.js: rejoindreFile` | oui |
| RG-03 | Rang d'arrivée immuable | `state.js: TICKET_CREE` | oui |
| RG-04 | Fermeture = 19h00 − attente − marge | `commands.js: etatInscriptions` | oui |
| RG-05 | Seuil de vigilance | `scheduler.js: avertirFinDeJournee` | — |
| RG-06 | Super Saiyan prioritaire, plafonné à 15 % | `scheduler.js: urgence` + quotas | oui |
| RG-07 | Garantie Saiyan ou fermeture des inscriptions | `commands.js: etatInscriptions` | oui |
| RG-08 | Part minimale réservée aux Humains | `scheduler.js: reserveHumain` | oui |
| RG-09 | Convocation 10 min + délai de grâce | `commands.js: scanner`, `scheduler.js` | oui |
| RG-10 | Expiration et réattribution de la place | `scheduler.js: expirerConvocations` | oui |
| RG-11 | Agent : jamais d'ajout, motif obligatoire | absence de route + `exigerMotif` | oui |
| RG-12 | La pause gèle et restitue les compteurs | `state.js: tempsActifEcoule` | oui |
| RG-13 | Conservation de l'ordre après panne | `eventStore.js: chargerJournee` | oui |
| RG-14 | Désistement et retrait définitifs, QR révoqué | `commands.js: seDesister` + état du ticket | oui |
| RG-15 | Seuils modifiables sans redéploiement | `REGLES_MODIFIEES` + `validerRegles` | oui |

### Le garde-fou de RG-11

Le cahier des charges demande qu'aucune entrée dans la file ne puisse venir d'un
opérateur, et que ce soit garanti par l'absence d'interface **et de route**.

Ici, `rejoindreFile()` est appelée à un seul endroit du code, dans la route
`POST /api/queues/:id/tickets`, protégée par `exigerVisiteur`. Toute route
inconnue sous `/api/` répond 404 au lieu de servir la page web, ce qui rend
l'absence vérifiable de l'extérieur :

```bash
curl -X POST localhost:3000/api/agent/tickets   # 404
curl -X POST localhost:3000/api/admin/tickets   # 404
```

Un test automatisé vérifie en plus que le code source ne contient qu'un seul
appel à cette commande.

---

## API

Toutes les routes sont préfixées par `/api`.

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/auth/magic-link`, `/auth/verify` | public |
| POST | `/auth/backoffice/login` | public |
| GET | `/me`, `/me/messages`, `/me/export` | visiteur |
| POST | `/me/consents`, `/me/eligibility` | visiteur |
| DELETE | `/me` | visiteur |
| GET | `/queues/:id`, `/queues/:id/wait-times`, `/queues/:id/stream` | public |
| POST | `/queues/:id/tickets` | **visiteur uniquement** |
| GET | `/tickets/:id`, `/tickets/:id/qr` | visiteur |
| DELETE | `/tickets/:id` | visiteur |
| POST | `/agent/scans`, `/agent/incidents` | agent |
| POST | `/agent/queues/:id/pause`, `/resume`, `/purge`, `/reopen` | agent |
| GET | `/agent/queue`, `/agent/incidents` | agent |
| DELETE | `/agent/tickets/:id?motif=…` | agent |
| GET | `/sensors/waiting-room/:id` | public |
| PUT | `/mock/sensors` | admin |
| GET | `/admin/metrics`, `/admin/config/rules`, `/admin/audit-logs`, `/admin/mailbox` | admin |
| PUT | `/admin/config/rules` | admin |
| GET/POST | `/admin/clock` | admin |
| POST | `/admin/seed` | admin |
| GET | `/health` | public |

---

## Configuration

Les règles se modifient à chaud depuis le tableau de bord, ou par
`PUT /api/admin/config/rules`. Chaque valeur est bornée : une saisie hors bornes
est refusée avec un message explicite, et la modification est tracée dans
l'audit. Les valeurs par défaut sont dans `src/config/rules.js`.

Variables d'environnement, toutes facultatives :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `WAITLESS_SECRET` | secret de démo | clé de signature des sessions et des QR |
| `WAITLESS_SILENCIEUX` | non défini | coupe l'affichage des e-mails simulés |

L'URL du capteur se règle dans les règles (`capteurUrl`), pas par variable
d'environnement : c'est un paramètre d'exploitation, modifiable sans redémarrage.
Le capteur doit répondre en JSON, au choix `{"count": 12}` ou simplement `12`.
Si l'URL est vide ou injoignable, l'application retombe sur un comptage interne
et le signale dans le tableau de bord.

---

## Limites assumées

Ces écarts au cahier des charges sont des choix, pas des oublis.

- **E-mails simulés.** Aucun SMTP. Les messages s'affichent dans la console et
  dans l'application (tableau de bord → boîte d'envoi, ou onglet « Mes données »
  côté visiteur). Cela supprime le risque de délivrabilité du chapitre 8 et rend
  la démonstration lisible. Brancher un service réel ne change que `mailer.js`.
- **Journal fichier au lieu de PostgreSQL.** L'exigence réelle est la durabilité
  de l'ordre, pas la richesse des requêtes. Le passage à PostgreSQL ne toucherait
  que `eventStore.js`.
- **Capteur non réalisé.** Conformément à ce qui a été convenu, l'application se
  contente de consommer l'URL fournie par le capteur.
- **Rendu du QR par une bibliothèque externe.** C'est la seule ressource réseau
  du projet, et elle est facultative : sans elle, le code s'affiche en clair et
  l'agent le saisit à la main — le mode dégradé prévu au chapitre 8.
- **Hors périmètre**, car non demandés dans le MVP : billetterie et paiement,
  multi-attractions, applications natives, gestion des groupes.

## Et ensuite

Rien n'est couplé à l'environnement : pas de chemin absolu, pas de service
externe obligatoire, le port et les secrets viennent de l'environnement. La
containerisation tiendra en quelques lignes :

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

Le seul point à traiter à ce moment-là est le dossier `data/`, qui doit devenir
un volume pour que le journal survive au redémarrage du conteneur.
