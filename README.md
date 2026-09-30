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
   │  on profite du parc  │  se présenter    │  devant la porte  │
   └──────────────────────┘                  └─────────┬─────────┘
                                                       │ 2ᵉ scan, si
                                                       │ une place s'est
                                                       │ libérée
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
3. **Premier scan.** À son arrivée, l'agent scanne son QR code. Le compte à
   rebours s'arrête : le visiteur est là, il ne peut plus être déclaré absent.
4. **Second scan.** Le capteur indique à l'agent combien de personnes se
   trouvent dans la salle. Dès qu'une place se libère, il rescanne le **même**
   code et fait entrer le visiteur. Le code est alors consommé.
5. **Sortie.** On quitte la salle quand on veut, sans rien scanner. C'est
   pourquoi le capteur est indispensable : le système sait qui entre, il ne peut
   pas savoir qui sort.

Trois conséquences qui expliquent la forme du code :

- **Il n'y a ni cycle, ni fournée, ni horaire de passage.** La salle fonctionne
  en flux continu. Le débit n'est pas décrété, il se déduit de la capacité et de
  la durée de séjour (30 s à 2 min, 75 s en moyenne), puis se recale sur les
  entrées observées. À ce rythme, la salle se renouvelle très vite : en pratique,
  c'est le contrôle à l'entrée et le trajet des convoqués qui limitent le débit.
- **L'ordonnanceur ne décide pas qui entre dans la salle.** Il décide seulement
  qui quitte le parc pour aller faire la queue. C'est l'agent, au second scan,
  qui fait entrer. La régulation par la capacité de la salle est donc physique :
  salle pleine → personne n'entre → la file réelle ne se vide pas →
  l'ordonnanceur cesse de convoquer, faute de place. Rien de tout cela n'est
  codé comme une règle ; cela découle du modèle.
- **Le même QR code sert deux fois, et pas une de plus.**

---

## Démarrer

Prérequis : **Node.js 18 ou plus**. Rien d'autre. Pas de `npm install`, pas de
base de données à installer, pas de Docker : le projet n'a **aucune dépendance**.

```bash
node seed.js --heure=10:00 --arrivees=12 --entrees=6   # peuple les trois étages
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
node seed.js --arrivees=12   # dont 12 déjà arrivés dans la file réelle
node seed.js --entrees=6     # dont 6 déjà entrés dans la salle
node --test test/*.test.js   # lance les 40 tests des règles métier
```

Le peuplement emprunte le vrai parcours, scans compris : rien n'est écrit
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
   Super Saiyans. Dans la console agent, onglet **File**, on voit l'ordre réel :
   les Super Saiyans passent devant, les Saiyans remontent quand leur garantie
   de 30 minutes approche, et une part des convocations reste réservée aux
   Humains.
3. **Convocation.** L'écran du visiteur bascule en plein écran : un compte à
   rebours pour **rejoindre la file** et un QR code.
4. **Premier scan.** Console agent → scanner le code. Verdict ambre :
   « Arrivée enregistrée ». Côté visiteur, le compte à rebours disparaît et
   laisse place à sa position dans la file réelle. Attendre : il n'expire plus.
5. **Second scan.** Rescanner le même code. Verdict vert : « Entrée autorisée ».
   Rescanner une troisième fois : refusé, usage unique. Attendre 30 secondes et
   rescanner un ancien code : refusé, il a tourné.
6. **Salle pleine.** Tableau de bord → **Affluence** → forcer l'occupation à 50.
   Scanner quelqu'un de la file réelle : refusé, « Salle pleine (50/50) ». Son
   ticket reste intact et il garde sa place. Libérer le forçage, rescanner :
   accepté. C'est le point le plus important de la démonstration — un plafond
   n'est pas une punition.
7. **Plafond de la file réelle.** Peupler avec 60 visiteurs : l'ordonnanceur
   s'arrête exactement à 30 personnes engagées, convoqués en route compris, et
   laisse les autres profiter du parc.
8. **Incident.** Console agent → **Incidents** → mettre en pause avec un motif.
   Tous les compteurs se figent côté visiteur, un message part, et la reprise
   restitue exactement le temps restant.
9. **Fin de journée.** Régler l'horloge sur `18:40`. Les inscriptions se ferment
   d'elles-mêmes, statut par statut, et les derniers inscrits reçoivent
   l'avertissement de vigilance.
10. **Panne.** Tuer le serveur brutalement (`Ctrl+C`, ou `kill -9`), puis
    `node server.js`. La file virtuelle, l'ordre physique de la file réelle, les
    rangs et les convocations en cours sont identiques : rien n'est perdu.

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
│       ├── billetterie.js  référentiel des statuts (simulé)
│       └── jeuDeDonnees.js peuplement de démonstration
├── public/                 interface web (HTML + CSS + JS, sans framework)
└── test/regles.test.js     40 tests, un par règle critique
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

**Un état de ticket par étage.** `EN_ATTENTE` dans le parc, `CONVOQUE` en route,
`EN_FILE_REELLE` devant la porte, `ENTRE` dans la salle. C'est ce découpage qui
permet de compter séparément les 30 places de la file et les 50 de la salle, et
surtout de n'appliquer l'expiration qu'aux `CONVOQUE` : un visiteur présent
devant l'agent ne peut pas être déclaré absent, quelle que soit la durée de son
attente.

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
| F-10 | QR nominatif rotatif, deux usages puis journalier | `domain/qr.js` + états du ticket |
| F-11 | Scan agent avec verdict < 1 s | `commands.js: scanner`, console agent |
| F-12 | Retrait, pause, reprise, purge avec motif | `commands.js` (`retirerTicket`, `mettreEnPause`, `reprendre`, `purger`) |
| F-13 | Conservation de l'ordre après incident ou panne | `domain/eventStore.js` |
| F-14 | Capteur de la Salle du Temps | `infra/sensor.js`, plafond appliqué dans `commands.js: scanner` |
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
| RG-10 | Expiration du convoqué absent, jamais du présent | `scheduler.js: expirerConvocations` | oui |
| RG-11 | Agent : jamais d'ajout, motif obligatoire | absence de route + `exigerMotif` | oui |
| RG-12 | La pause gèle et restitue les compteurs | `state.js: tempsActifEcoule` | oui |
| RG-13 | Conservation de l'ordre après panne | `eventStore.js: chargerJournee` | oui |
| RG-14 | Désistement et retrait définitifs, QR révoqué | `commands.js: seDesister` + état du ticket | oui |
| RG-15 | Seuils modifiables sans redéploiement | `REGLES_MODIFIEES` + `validerRegles` | oui |
| RG-16 | La file réelle ne dépasse jamais 30 personnes | `scheduler.js: ordonnancer`, `state.js: placesFileReelle` | oui |
| RG-17 | La salle ne dépasse jamais 50 ; un refus ne consomme rien | `commands.js: scanner` | oui |
| RG-18 | Le QR sert exactement deux fois, dans l'ordre | `commands.js: scanner` (étapes) | oui |

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

### Les deux scans, et pourquoi il en faut deux

Avec un seul scan, à la porte de la salle, un visiteur sagement arrivé dans la
file réelle verrait sa convocation expirer si aucune place ne se libère dans les
dix minutes. On le punirait d'une lenteur qui n'est pas la sienne.

Avec deux scans, le délai de convocation ne mesure plus que ce que le visiteur
maîtrise — le trajet. Le reste de l'attente, debout devant l'attraction, n'a plus
de limite de temps et ne peut plus lui coûter sa place. En prime, le système sait
distinguer un absent d'un présent qui attend, ce qui est exactement la mesure
dont l'exploitant a besoin.

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
| POST | `/agent/scans` | agent — étape déduite de l'état du ticket |
| POST | `/agent/scans/arrivee`, `/agent/scans/entree` | agent — étape forcée |
| POST | `/agent/incidents` | agent |
| POST | `/agent/queues/:id/pause`, `/resume`, `/purge`, `/reopen` | agent |
| GET | `/agent/queue`, `/agent/incidents` | agent |
| DELETE | `/agent/tickets/:id?motif=…` | agent |
| GET | `/sensors/time-chamber/:id` | public |
| PUT | `/mock/sensors` | admin |
| GET | `/admin/metrics`, `/admin/config/rules`, `/admin/audit-logs`, `/admin/mailbox` | admin |
| PUT | `/admin/config/rules` | admin |
| GET/POST | `/admin/clock` | admin |
| POST | `/admin/seed` | admin |
| GET | `/health` | public |

`POST /api/agent/scans` renvoie trois verdicts : `ARRIVEE` (le visiteur prend
place dans la file réelle), `ACCEPTE` (il entre dans la salle) et `REFUSE`.

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

L'URL du capteur se règle dans les règles (`capteurUrl`), pas par variable
d'environnement : c'est un paramètre d'exploitation, modifiable sans redémarrage.
Le capteur doit répondre en JSON, au choix `{"count": 42}` ou simplement `42`.
Si l'URL est vide ou injoignable, l'application retombe sur une estimation
interne — les entrées scannées, moins celles dont la durée de séjour supposée est
écoulée — et le signale dans le tableau de bord.

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
- **Les sorties ne sont pas individualisées.** Le capteur donne un nombre, pas
  une liste. Le système sait donc qui est entré et à quelle heure, mais pas
  combien de temps chacun est resté. Un capteur renvoyant des identifiants
  (`{"count": 42, "ids": [...]}`) permettrait de mesurer la durée de séjour
  réelle et d'affiner le débit ; le champ est déjà lu par `sensor.js`.
- **L'ordre dans la file réelle n'est pas contrôlé à la porte.** L'agent scanne
  qui se présente. Cette file est physique : imposer un ordre depuis un écran,
  devant des gens qui se voient, créerait plus de conflits qu'elle n'en
  résoudrait. La console affiche l'ordre d'arrivée à titre indicatif.
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