# Waitless
*Skip the wait*

**Groupe n° 8 — Contributeurs :**
* Chirine BOUKYOUD
* Ismael BELKACEMI
* Matthias TRUPIN
* Sanaa MOUSSA
* Taha SEFOUDINE

# WAITLESS — La Salle du Temps

##  Endpoints de l'API

| Ressource | Terminaisons principales | Accès |
| :--- | :--- | :--- |
| **Authentification** | `POST /auth/magic-link`<br>`POST /auth/verify`<br>`POST /auth/backoffice/login` | Public |
| **Profil et consentements** | `GET /me`<br>`PATCH /me`<br>`POST /me/consents`<br>`POST /me/eligibility` | Visiteur |
| **File** | `GET /queues/{id}`<br>`GET /queues/{id}/wait-times`<br>`GET /queues/{id}/stream` | Visiteur |
| **Tickets** | `POST /queues/{id}/tickets`<br>`GET /tickets/{id}`<br>`DELETE /tickets/{id}`<br>`GET /tickets/{id}/qr` | Visiteur |
| **Actions agent** | `POST /agent/scans`<br>`POST /agent/queues/{id}/pause`<br>`POST /agent/queues/{id}/resume`<br>`POST /agent/queues/{id}/purge`<br>`DELETE /agent/tickets/{id}`<br>`POST /agent/incidents` | Agent |
| **Capteur et contexte** | `GET /sensors/waiting-room/{id}`<br>`PUT /mock/sensors`<br>`PUT /mock/context/weather`<br>`PUT /mock/context/park-attendance` | Système / Admin |
| **Métriques et règles** | `GET /admin/metrics/*`<br>`GET /admin/config/rules`<br>`PUT /admin/config/rules`<br>`GET /admin/audit-logs` | Admin |

---

##  Modèle de Données

| Entité | Rôle | Attributs clés |
| :--- | :--- | :--- |
| **Visiteur** | Personne inscrite pour la journée | E-mail, prénom et initiale, statut de priorité, aptitude, référence de billet |
| **Statut de priorité** | Référentiel configurable | Code, rang, garantie de délai, quota par cycle, part minimale |
| **File** | Instance quotidienne d'une attraction | État, heures d'ouverture et de clôture, débit réel, indicator de vigilance |
| **Ticket** | Position d’un visiteur dans la file | Rang d'arrivée immuable, état, heure estimée, échéance de garantie, temps gelé |
| **Créneau** | Cycle d’exploitation | Début, capacité, places consommées, quota prioritaire |
| **Convocation** | Invitation à se présenter | Émission, expiration, rappel, état |
| **Jeton QR** | Preuve d’accès rotative | Identifiant unique, validité courte, clé du jour, consommation |
| **Scan** | Contrôle réalisé par l’agent | Horodatage, verdict, identité vérifiée |
| **Incident** | Aléa d’exploitation | Type, début et fin, impact, motif, tickets concernés |
| **Événement de file** | Journal ordonné de toutes les actions | Type, horodatage, données, support de la reprise après panne |
| **Consentement** | Preuve du recueil | Type, version du texte accepté, date |
| **Paramètre de règle** | Configuration modifiable à chaud | Clé, valeur, bornes, auteur et date de modification |

---

##  Fonctionnalités et Règles Métier

### Périmètre fonctionnel livré (MVP)

| Réf. | Fonctionnalité | Critère d’acceptation |
| :--- | :--- | :--- |
| **F-01** | Connexion par lien e-mail, consentement et décharge « plusieurs G » | Inscription impossible sans acceptation tracée |
| **F-02** | Déclaration d’aptitude convertie en statut dérivé | Aucune donnée de santé brute en base |
| **F-03** | Ouverture de la file à 8h, exploitation de 9h à 19h | Aucune convocation émise avant 9h |
| **F-04** | Inscription avec temps d’attente prévisionnel | Estimation affichée dès la création du ticket |
| **F-05** | Suivi en temps réel de la position | Mise à jour en moins de 5 secondes |
| **F-06** | Fermeture automatique des inscriptions | Aucun passage promis au-delà de 19h00 |
| **F-07** | Notification de vigilance de fin de journée | Envoyée une seule fois par ticket |
| **F-08** | Convocation de 10 minutes et délai de grâce | Scan accepté pendant la grâce, refusé après |
| **F-09** | Trois statuts de priorité avec quotas | Garantie Saiyan tenue en situation de charge |
| **F-10** | QR code nominatif rotatif, à usage unique et journalier | Une capture d'écran est refusée après expiration |
| **F-11** | Scan et validation par l’agent | Verdict affiché en moins d’une seconde, motif en cas de refus |
| **F-12** | Retrait, pause, reprise et purge par l’agent | Motif obligatoire, action tracée |
| **F-13** | Conservation de l’ordre après incident ou panne | Redémarrage sans perte de position |
| **F-14** | Capteur simulé de la salle d’attente | Convocations régulées sur l’occupation réelle |
| **F-15** | Tableau de bord administrateur | Remplissage et temps d’attente par statut, rafraîchis en continu |
| **F-16** | Configuration des règles sans redéploiement | Modification prise en compte en moins d’une minute |

### Règles métier applicables

| Réf. | Règle |
| :--- | :--- |
| **RG-01** | La file ouvre à 8h00 avec le parc ; les convocations ne démarrent qu'à 9h00 et cessent à 19h00. |
| **RG-02** | L'inscription exige une session authentifiée, le consentement, la décharge de responsabilité et le statut « apte ». Un seul ticket actif par visiteur. |
| **RG-03** | Le rang d'arrivée attribué à l'inscription est immuable : aucune action humaine ni technique ne peut le modifier. |
| **RG-04** | Les inscriptions ferment automatiquement à 19h00 moins l'attente estimée moins une marge de sécurité, statut par statut. |
| **RG-05** | Sous le seuil de vigilance, les derniers inscrits sont avertis que leur passage pourrait ne pas être assuré et peuvent quitter la file. |
| **RG-06** | Super Saiyan : accès prioritaire absolu, sans file, dans la limite de 15 % des places d'un cycle pour protéger les autres statuts. |
| **RG-07** | Saiyan : attente garantie à 30 minutes maximum. Si la garantie ne peut plus être tenue, les inscriptions Saiyan ferment plutôt que de promettre à tort. |
| **RG-08** | Humain : file classique par ordre d'arrivée, avec une part minimale de places réservées à chaque cycle pour éviter la famine. |
| **RG-09** | Le visiteur convoqué dispose de 10 minutes pour se présenter, suivies d'un délai de grâce paramétrable de 30 à 60 secondes. |
| **RG-10** | Passé ce délai, le ticket expire et la place est réattribuée ; le visiteur peut se réinscrire en fin de file. |
| **RG-11** | L'agent peut retirer, mettre en pause ou purger, toujours avec un motif. Il ne peut jamais ajouter un visiteur : aucune interface ni route d'API ne le permet. |
| **RG-12** | Une mise en pause gèle tous les compteurs et les restitue à l'identique à la reprise. |
| **RG-13** | En cas d'incident ou de panne, l'ordre et les positions sont conservés et le service reprend exactement là où il s'est arrêté. |
| **RG-14** | Le désistement du visiteur comme le retrait par l'agent sont définitifs et révoquent immédiatement le QR code. |
| **RG-15** | Tous les seuils (délais, quotas, capacités, marges) sont modifiables depuis le tableau de bord, sans redéploiement. |

---

##  Planning et Rétroplanning

| Séance / Jalon | Objectif | Livrables |
| :---: | :--- | :--- |
| **Séance 1** | Cadrage et fondations *(Le socle technique tourne)* | • Périmètre validé<br>• Modèle de données figé<br>• Dépôt et intégration continue (CI/CD) en place<br>• Maquettes des 3 interfaces<br>• Jeu de données fictif |
| **Séance 2** | Cœur métier *(La file fonctionne de bout en bout)* | • Inscription visiteurs<br>• Moteur d'estimation<br>• Ordonnancement des 3 statuts<br>• Gestion des convocations<br>• Génération QR code & module de scan<br>• Écrans de l'application visiteur |
| **Séance 3** | Robustesse et pilotage *(Le système résiste aux aléas)* | • Actions d'urgence (Pause, Reprise, Purge, Retrait)<br>• Mécanisme de reprise après panne<br>• Envoi des notifications<br>• Clôture automatique des files<br>• Tableau de bord admin & écran de paramétrage |
| **Séance 4** | Finition et livraison *(Livrer et soutenir)* | • Recette fonctionnelle complète<br>• Intégration des bonus retenus<br>• Documentation finale<br>• Déploiement de l'application<br>• Répétition générale de la démonstration |
