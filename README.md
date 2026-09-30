# Waitless — La Salle du Temps

File d'attente virtuelle pour l'attraction « La Salle du Temps ». Les visiteurs
prennent leur place depuis leur téléphone, profitent du parc, et ne se déplacent
qu'au moment d'entrer.

Démonstrateur du cahier des charges v1.0 du 2 septembre 2026. Les 16 fonctions
du MVP (F-01 à F-16) et les 18 règles métier (RG-01 à RG-18) sont implémentées.

---

## Le parcours, en trois étages

C'est le modèle qui commande tout le reste du code, et il vaut la peine d'être
lu avant d'ouvrir un fichier.

```
   ┌──────────────────────┐   convocation    ┌───────────────────┐
   │  1. FILE VIRTUELLE   │ ───────────────> │  2. FILE RÉELLE   │
   │  illimitée           │  10 min pour     │  30 personnes max │
   │  on profite du parc  │  se présenter    │  QR scanné une    │
   └──────────────────────┘                  │  fois, à l'entrée │
                                             └─────────┬─────────┘
                                                       │ un agent, sans
                                                       │ application, fait
                                                       │ entrer quand une
                                                       │ place se libère
                                             ┌─────────▼─────────┐
                                             │ 3. SALLE DU TEMPS │
                                             │  50 personnes max │
                                             │  on sort quand    │
                                             │  on veut          │
                                             └───────────────────┘
```

1. **Inscription.** Le visiteur prend son rang depuis son téléphone et continue
   sa visite. Cette file n'a pas de limite de taille.
2. **Convocation.** Quand une place se libère dans la file réelle, l'ordonnanceur
   appelle le visiteur suivant. Il a 10 minutes (plus un délai de grâce) pour
   **rejoindre la file d'attente installée devant l'attraction**.
3. **Scan.** À son arrivée au début de la file réelle, l'agent scanne son QR
   code. C'est le **seul** scan du parcours : l'agent vérifie le code, le compte
   à rebours s'arrête et le code est consommé.
4. **Entrée dans la salle.** Un second agent, **sans application**, fait entrer
   les visiteurs de la file réelle dès qu'une place se libère (il s'appuie sur
   le capteur). Il n'y a pas de seconde vérification.
5. **Sortie.** On quitte la salle quand on veut, sans rien scanner. Le capteur
   est la seule source qui sache combien de personnes sont dans la salle.

Trois conséquences qui expliquent la forme du code :

- **Il n'y a ni cycle, ni fournée, ni horaire de passage.** La salle fonctionne
  en flux continu. Le débit n'est pas décrété, il se déduit de la capacité et de
  la durée de séjour (30 s à 2 min, 75 s en moyenne), puis se recale sur les
  entrées observées. À ce rythme, la salle se renouvelle très vite : en pratique,
  c'est le contrôle à l'entrée et le trajet des convoqués qui limitent le débit.
- **L'ordonnanceur ne décide pas qui entre dans la salle.** Il décide seulement
  qui quitte le parc pour aller faire la queue. C'est l'agent de la porte, sans
  application, qui fait entrer.
- **Le système ne sait pas qui est dans la file réelle et qui est déjà dans la
  salle.** Pour lui, le parcours s'arrête au scan. L'occupation de la file
  réelle est donc une **estimation** : les convoqués en route, plus les scannés
  présumés encore dans la file (écoulement dans l'ordre du scan, au débit
  effectif, gelé pendant une pause).
- **Le QR code sert une fois, et pas une de plus.**

---

## Démarrer

Prérequis : **Node.js 18 ou plus**. Rien d'autre. Pas de `npm install`, pas de
base de données à installer, pas de Docker : le projet n'a **aucune dépendance**.

```bash
node seed.js --heure=10:00 --scannes=12   # peuple la file et fait scanner 12 convoqués
node server.js                                          # démarre le serveur
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
node seed.js --nombre=60     # 60 visiteurs dans la file virtuelle
node seed.js --scannes=12    # dont 12 déjà scannés à l'entrée de la file réelle
node --test test/*.test.js   # lance les 39 tests des règles métier
```

Le peuplement emprunte le vrai parcours, scan compris : rien n'est écrit
directement dans le journal. Les tests, eux, travaillent dans un dossier
temporaire et n'effacent jamais la journée en cours.

---

## Scénario de démonstration

L'horloge d'exploitation est pilotable depuis le tableau de bord
(onglet **Règles**). C'est ce qui permet de montrer une journée entière en cinq
minutes, sans attendre 19h00.

1. **Inscription.** Se connecter comme visiteur, accepter les conditions et la
   décharge, se déclarer apte, rejoindre la file. L'attente s'affiche en deux
   parties : le temps à passer dans le parc, puis le temps debout devant
   l'attraction.
2. **Priorités.** Le jeu de données contient des Humains, des Saiyans et des
   Super Saiyans. Dans la console agent, onglet **File**, on voit l'ordre :
   les Super Saiyans passent devant, les Saiyans remontent quand leur garantie
   de 30 minutes approche, et une part des convocations reste réservée aux
   Humains.
3. **Convocation.** L'écran du visiteur bascule en plein écran : un compte à
   rebours pour **rejoindre la file** et un QR code.
4. **Scan.** Console agent → scanner le code. Verdict vert : « Code valide ».
   Côté visiteur, le compte à rebours disparaît : « Code validé, suivez la
   file ». Rescanner : refusé, usage unique. Attendre 30 secondes et scanner un
   ancien code : refusé, il a tourné.
5. **Plafond de la file réelle.** Peupler avec 60 visiteurs : l'ordonnanceur
   s'arrête exactement à 30 personnes engagées, convoqués en route compris, et
   laisse les autres profiter du parc.
6. **Utilisateurs.** Tableau de bord → **Utilisateur** : corriger l'aptitude
   ou le statut d'un visiteur. La modification apparaît dans l'onglet **Log**.
7. **Incident.** Console agent → **Incidents** → mettre en pause avec un motif.
   Tous les compteurs se figent côté visiteur, un message part, et la reprise
   restitue exactement le temps restant.
8. **Fin de journée.** Régler l'horloge sur `18:40`. Les inscriptions se ferment
   d'elles-mêmes, statut par statut, et les derniers inscrits reçoivent
   l'avertissement de vigilance.
9. **Panne.** Tuer le serveur brutalement (`Ctrl+C`, ou `kill -9`), puis
   `node server.js`. La file virtuelle, les scans, les rangs et les
   convocations en cours sont identiques : rien n'est perdu.

---

## Architecture

```
waitless/
├── server.js               point d'entrée : charge le journal, monte l'API, lance le battement
├── seed.js                 jeu de données fictif en ligne de commande
├── src/
│   ├── config/rules.js     valeurs par défaut + bornes de validité des règles
│   ├── config/urls.js      URLs du capteur et de la billetterie
│   ├── domain/             ← tout le métier, sans HTTP ni fichiers
│   │   ├── clock.js        horloge d'exploitation pilotable
│   │   ├── state.js        état + réducteur d'événements + les trois étages
│   │   ├── eventStore.js   journal append-only, reconstruction de l'état
│   │   ├── estimator.js    estimation itérative de l'attente, en deux parties
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
│       ├── sensor.js       capteur de la Salle du Temps
│       ├── billetterie.js  référentiel des statuts (GET sur l'URL, sinon fichier local)
│       └── jeuDeDonnees.js peuplement de démonstration
├── public/                 interface web (HTML + CSS + JS, sans framework)
└── test/regles.test.js     39 tests, un par règle critique
```

La dépendance va toujours dans le même sens : `api → domain → (rien)`, et
`infra` est appelée par le domaine à travers des fonctions simples. Le domaine
ne connaît ni HTTP, ni le format du stockage, ni le navigateur. C'est ce qui
rend les règles testables sans démarrer le serveur.

### Quatre décisions structurantes

**Journal d'événements plutôt qu'une table d'états.** Rien n'est écrasé : chaque
fait est ajouté en fin de fichier (`data/evenements-AAAA-MM-JJ.jsonl`), et l'état
est reconstruit en rejouant le journal au démarrage. RG-13 (« conservation de
l'ordre après panne ») n'est donc pas une fonctionnalité en plus : c'est une
conséquence du stockage. L'écriture est synchrone, pour qu'un événement accepté
soit réellement sur le disque avant la réponse.

**Un état de ticket par étape connue du système.** `EN_ATTENTE` dans le parc,
`CONVOQUE` en route, `VALIDE` une fois le code scanné à l'entrée de la file
réelle. L'expiration ne s'applique qu'aux `CONVOQUE` : un visiteur scanné ne
peut plus être déclaré absent.

**Séparation commandes / vues.** Les écritures passent par `commands.js`, qui
vérifie les règles et publie des événements. Les lectures passent par
`views.js`, qui projette l'état pour chaque interface. Aucune interface ne lit
l'état interne directement.

**Horloge d'exploitation injectée.** Le domaine ne lit jamais `Date.now()`. Il
demande l'heure à `clock.js`, qui peut être décalée et accélérée. Sans cela, il
serait impossible de tester la fermeture de 19h00 ou de démontrer un parcours
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
| F-08 | Convocation vers la file réelle, délai et grâce | `scheduler.js: ordonnancer`, `expirerConvocations` |
| F-09 | Trois statuts et leurs quotas | `config/rules.js: statuts`, `scheduler.js: comptageFenetre` |
| F-10 | QR nominatif rotatif, usage unique et journalier | `domain/qr.js` + états du ticket |
| F-11 | Scan agent avec verdict < 1 s | `commands.js: scanner`, console agent |
| F-12 | Retrait, pause, reprise, purge avec motif | `commands.js` (`retirerTicket`, `mettreEnPause`, `reprendre`, `purger`) |
| F-13 | Conservation de l'ordre après incident ou panne | `domain/eventStore.js` |
| F-14 | Capteur de la Salle du Temps | `infra/sensor.js`, affiché aux équipes |
| F-15 | Tableau de bord exploitant | `api/views.js: vueMetriques` |
| F-16 | Configuration des règles sans redéploiement | `config/rules.js: validerRegles`, `PUT /api/admin/config/rules` |

## Traçabilité — règles métier

| # | Règle | Où | Testée |
|---|---|---|---|
| RG-01 | Horaires d'ouverture et d'exploitation | `commands.js: etatInscriptions`, `scheduler.js` | oui |
| RG-02 | Session, consentement, aptitude, un seul ticket | `commands.js: rejoindreFile` | oui |
| RG-03 | Rang d'arrivée immuable | `state.js: TICKET_CREE` | oui |
| RG-04 | Fermeture = 19h00 − attente totale − marge | `commands.js: etatInscriptions` | oui |
| RG-05 | Seuil de vigilance | `scheduler.js: avertirFinDeJournee` | oui |
| RG-06 | Super Saiyan prioritaire, plafonné à 15 % | `scheduler.js: urgence` + `plafond` | oui |
| RG-07 | Garantie Saiyan (jusqu'à la convocation) ou fermeture | `scheduler.js: resteGarantieMin`, `commands.js` | oui |
| RG-08 | Part minimale réservée aux Humains | `scheduler.js: reserveHumain` | oui |
| RG-09 | 10 min pour rejoindre la file réelle + délai de grâce | `commands.js: scanner`, `scheduler.js` | oui |
| RG-10 | Expiration du convoqué absent, jamais du scanné | `scheduler.js: expirerConvocations` | oui |
| RG-11 | Agent : jamais d'ajout, motif obligatoire | absence de route + `exigerMotif` | oui |
| RG-12 | La pause gèle et restitue les compteurs | `state.js: tempsActifEcoule` | oui |
| RG-13 | Conservation de l'ordre après panne | `eventStore.js: chargerJournee` | oui |
| RG-14 | Désistement et retrait définitifs, QR révoqué | `commands.js: seDesister` + état du ticket | oui |
| RG-15 | Seuils modifiables sans redéploiement | `REGLES_MODIFIEES` + `validerRegles` | oui |
| RG-16 | La file réelle ne dépasse pas 30 personnes (estimée) | `scheduler.js: ordonnancer`, `estimator.js: placesFileReelle` | oui |
| RG-17 | La salle ne dépasse pas 50 : régulée à la porte, pas au scan | agent de la porte + capteur | oui |
| RG-18 | Le QR sert exactement une fois | `commands.js: scanner` | oui |

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

### Un seul scan

L'agent de la file réelle scanne le QR code et vérifie qu'il est valide : c'est
tout. Il ne contrôle pas le remplissage de la salle. Un second agent, sans
application, fait entrer les visiteurs au rythme des places libérées, sans
seconde vérification.

Le délai de convocation ne mesure donc que le trajet : une fois scanné, le
visiteur ne peut plus perdre sa place, quelle que soit la durée de son attente
devant la salle.

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
| POST | `/agent/scans` | agent — scan à l'entrée de la file réelle |
| POST | `/agent/incidents` | agent |
| POST | `/agent/queues/:id/pause`, `/resume`, `/purge`, `/reopen` | agent |
| GET | `/agent/queue`, `/agent/incidents` | agent |
| DELETE | `/agent/tickets/:id?motif=…` | agent |
| GET | `/sensors/time-chamber/:id` | public |
| PUT | `/mock/sensors` | admin |
| GET | `/admin/metrics`, `/admin/config/rules`, `/admin/audit-logs`, `/admin/mailbox` | admin |
| GET | `/admin/users` | admin |
| PUT | `/admin/users/:id` | admin — prénom, initiale, statut, aptitude |
| PUT | `/admin/config/rules` | admin |
| GET/POST | `/admin/clock` | admin |
| POST | `/admin/seed` | admin |
| GET | `/health` | public |

`POST /api/agent/scans` renvoie deux verdicts : `ACCEPTE` (code valide, le
visiteur entre dans la file réelle) et `REFUSE`, toujours avec un motif.

---

## Configuration

Les règles se modifient à chaud depuis le tableau de bord, ou par
`PUT /api/admin/config/rules`. Chaque valeur est bornée : une saisie hors bornes
est refusée avec un message explicite, et la modification est tracée dans
l'audit. Les valeurs par défaut sont dans `src/config/rules.js`.

Les principales :

| Règle | Défaut | Rôle |
|---|---|---|
| `capaciteSalle` | `50` | places dans la Salle du Temps |
| `capaciteFileReelle` | `30` | places dans la file devant l'attraction |
| `dureeSejourMinSec` | `30` | durée de séjour la plus courte (s) |
| `dureeSejourMaxSec` | `120` | durée de séjour la plus longue (s) ; la moyenne des deux est la base du débit |
| `delaiConvocationSec` | `600` | temps laissé pour **rejoindre la file réelle** |
| `delaiGraceSec` | `120` | tolérance avant expiration |
| `fenetreQuotaConvocations` | `50` | fenêtre glissante sur laquelle s'appliquent les quotas |

Les quotas par statut ne peuvent plus s'exprimer « par cycle », puisqu'il n'y a
plus de cycle. « 15 % maximum pour les Super Saiyans » signifie désormais : sur
les 50 dernières convocations, pas plus de 15 % de Super Saiyans. La contrainte
est équivalente, et elle est continue.

Variables d'environnement, toutes facultatives :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `WAITLESS_SECRET` | secret de démo | clé de signature des sessions et des QR |
| `WAITLESS_SILENCIEUX` | non défini | coupe l'affichage des e-mails simulés |
| `WAITLESS_CAPTEUR_URL` | vide | URL du capteur de la Salle du Temps |
| `WAITLESS_BILLETTERIE_URL` | vide | URL de la base de la billetterie |

### URLs du capteur et de la billetterie

Les deux URLs sont réunies dans **`src/config/urls.js`**. On peut les changer :

1. dans ce fichier (valeur par défaut, durable) ;
2. au lancement : `WAITLESS_BILLETTERIE_URL=http://… WAITLESS_CAPTEUR_URL=http://… node server.js` ;
3. à chaud, dans le tableau de bord (onglet **Règles**, champs `capteurUrl` et
   `billetterieUrl`). Ce réglage vaut pour la journée en cours.

**Capteur.** Doit répondre en JSON, au choix `{"count": 42}` ou simplement `42`.
Si l'URL est vide ou injoignable, l'application retombe sur une estimation
interne — les codes scannés, moins ceux dont la durée de séjour supposée est
écoulée — et le signale dans le tableau de bord.

**Billetterie.** À chaque connexion d'un visiteur, Waitless fait d'abord un
`GET` sur cette URL pour récupérer la base des billets, puis y cherche l'e-mail.
Formats JSON acceptés :

```json
[ { "email": "lea@exemple.fr", "prenom": "Lea", "statut": "SAIYAN", "refBillet": "BIL-1000" } ]
{ "visiteurs": [ … ] }            // ou "users", ou "data"
{ "lea@exemple.fr": { "prenom": "Lea", "statut": "SAIYAN" } }
```

Statuts reconnus : `HUMAIN`, `SAIYAN`, `SUPER_SAIYAN` (un statut inconnu vaut
`HUMAIN`). Seuls le prénom, l'initiale, le statut, la référence du billet et
l'année de naissance sont conservés. Si l'URL est vide, injoignable (délai de
2 s), ou si l'e-mail n'y figure pas, on retombe sur `data/billetterie.json`,
puis sur un statut déduit de l'e-mail.

---

## Limites assumées

Ces écarts au cahier des charges sont des choix, pas des oublis.

- **E-mails simulés.** Aucun SMTP. Les messages s'affichent dans la console et
  via l'API (`GET /api/me/messages` pour le visiteur, `GET /api/admin/mailbox`
  pour la boîte d'envoi complète). Cela supprime le risque de délivrabilité du chapitre 8 et rend
  la démonstration lisible. Brancher un service réel ne change que `mailer.js`.
- **Journal fichier au lieu de PostgreSQL.** L'exigence réelle est la durabilité
  de l'ordre, pas la richesse des requêtes. Le passage à PostgreSQL ne toucherait
  que `eventStore.js`.
- **Capteur non réalisé.** Conformément à ce qui a été convenu, l'application se
  contente de consommer l'URL fournie par le capteur. Elle en tire une seule
  information, mais capitale : combien de personnes se trouvent dans la salle.
- **Pas de détection « dans la file ou dans la salle ».** L'entrée dans la
  salle n'est pas scannée : le système sait qui a été scanné et à quelle heure,
  pas qui est déjà entré. L'occupation de la file réelle est une estimation
  (écoulement au débit effectif), et les attentes « réelles » des métriques sont
  mesurées jusqu'au scan.
- **Les sorties ne sont pas individualisées.** Le capteur donne un nombre, pas
  une liste. Un capteur renvoyant des identifiants (`{"count": 42, "ids": [...]}`)
  permettrait d'affiner le débit ; le champ est déjà lu par `sensor.js`.
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