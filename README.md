# Plateforme API Management — SMT

Point d'entrée unique des banques vers les services SMT : la plateforme consomme les API des fournisseurs (SVIP vers SmartVista, SMT Cockpit, plateforme Chargeback, Plateforme 1) et les expose aux banques sous forme d'écrans (portail) et d'API, avec contrat, mise en service, abonnements, quotas, sécurité, facturation, engagements de service et audit.

Tous les composants sont gratuits et open source ; seul le système RHEL est payant.

## Prérequis

- RHEL 9 avec Podman 4.9+ et `podman compose` (ou Docker Engine + Docker Compose sur un poste de développement).
- 4 vCPU, 8 Go de RAM, 20 Go de disque pour le socle complet.
- `openssl` et `curl`. Node.js 22 uniquement pour développer le back-end hors conteneur.

## Démarrage

```bash
deploy/scripts/init.sh --dev   # génère .env, construit, démarre, attend que tout soit sain
deploy/scripts/check.sh        # état de santé à tout moment
deploy/scripts/qa-lot1.sh      # recette du lot 1 à travers la vraie passerelle
```

Le premier démarrage prend plusieurs minutes : ClamAV télécharge ses signatures antivirales.
Avec Docker au lieu de Podman : `COMPOSE="docker compose" ENGINE=docker deploy/scripts/init.sh --dev`.

Arrêt : `podman compose --env-file .env -f deploy/compose.yaml down` (ajouter `-v` efface les données).

## Services

| Service | Rôle | Port local (`--dev`) |
|---|---|---|
| apisix | Passerelle : seul point d'entrée des banques | 9080 (exposé), admin 9180 |
| etcd | Configuration d'APISIX | — |
| backend | Back-end NestJS : métier, console, BFF du portail | 3000 |
| postgres | Base de la plateforme et de Keycloak | 5432 |
| valkey | Droits, quotas et débits lus par la passerelle | 6379 |
| keycloak | Identité et rôles (royaume `smt`) | 8081 |
| seaweedfs | Fichiers : pièces, PV, bibliothèque (API S3) | 8333 |
| clamav | Antivirus des pièces déposées | — |
| simulateur | Faux fournisseur derrière la sandbox | 8080 |
| rabbitmq | Courtier de messages de la couche d'intégration | 5672, console 15672 |
| connector-chargeback | Litiges → plateforme Chargeback (ISO 8583:1993 sur TCP) | — |
| connector-cockpit | Demandes GAB, TPE, affiliation → SMT Cockpit ; réception des webhooks signés | — |
| sim-chargeback, sim-cockpit | Simulateurs de la sandbox | — |
| portail | Portail des banques (React, servi par nginx) | 5174 (exposé) |
| console | Console SMT (React, servi par nginx) | 5173 (127.0.0.1 seulement) |

Sans `--dev`, seul le port de la passerelle est exposé.

## Configuration

Toutes les variables sont décrites dans `.env.example`. `init.sh` crée `.env` avec des secrets aléatoires (droits 600) ; ce fichier n'est jamais versionné.

Une passerelle sert un seul environnement (`GATEWAY_ENVIRONMENT`) : `SANDBOX` envoie les appels aux simulateurs, `PRODUCTION` aux vrais fournisseurs. En production, on déploie une instance par environnement.

## Arborescence

```
backend/            back-end NestJS (src/, test/, Containerfile)
gateway/apisix/     plugins Lua de la passerelle (subscription-guard)
deploy/             compose, configuration APISIX, royaume Keycloak, scripts
CLAUDE.md           contexte du projet : contraintes, architecture, conventions, avancement
```

## Couche d'intégration (lot 4)

- **Outbox** : une action métier et son message sont enregistrés dans la même transaction PostgreSQL (`outbox_messages`), puis le relais du back-end les publie sur RabbitMQ (échange `apim`). Si le courtier est en panne, l'action réussit quand même : les messages repartent ensuite avec un délai croissant. Les messages traités sont mémorisés (`inbox_messages`) : un message rejoué est ignoré. Un message impossible à traiter va dans la file de rebut `apim.dlq`.
- **Litiges → Chargeback** : chaque action qui produit un message (1644, 1442, 1240, 1740) est encodée en ISO 8583:1993 et envoyée sur une connexion TCP persistante, avec un en-tête de longueur de 2 octets. La réponse (champ 39) apparaît dans l'historique : accusé, refusé ou échec d'envoi après 5 essais. La carte part masquée (champ 48) ; la transaction est identifiée par sa référence (champ 31). Ce format est à confirmer avec la spécification de la plateforme. Un écho réseau 1804 est envoyé chaque minute.
- **Demandes → SMT Cockpit** : une demande d'opération GAB, TPE ou affiliation est transmise automatiquement au Cockpit. Ses retours par webhook (`POST /webhooks/cockpit` sur le connecteur) sont signés en HMAC-SHA256 sur « horodatage.corps » et refusés au-delà de 5 minutes. Ils clôturent la demande, la rejettent avec un motif ou la mettent en attente de la banque. Une opération sensible exécutée par le Cockpit reste à valider par un agent. Si le Cockpit est injoignable, la demande revient dans la file des agents.
- **Simulateurs** (sandbox) : `sim-chargeback` accuse réception (code 000) ; il refuse un montant nul (110), le code motif 9999 (909) et une carte non masquée (902). `sim-cockpit` exécute l'ordre, le refuse si l'objet contient « REFUS », ou demande une information si l'objet contient « INFO ».
- En production, renseignez `CHARGEBACK_HOST` et `COCKPIT_URL` dans `.env`. Vides, ces variables pointent vers les simulateurs.

- **Services opérationnels (lot 4b)** : le portail affiche, en lecture, les transactions (Plateforme 1), les cartes et les comptes SmartVista (SVIP), ainsi que les GAB, les commerçants, les TPE et les affiliations (SMT Cockpit). Le back-end appelle chaque fournisseur au nom de la banque (`X-Partner-Code`). Il ne garde que les données de cette banque et masque tout numéro de carte complet qui lui parviendrait. Si un fournisseur est indisponible, l'écran l'indique (503 `PROVIDER_UNAVAILABLE`) et propose de créer une demande. Les actions (opposition, plafond, intervention GAB ou TPE, affiliation, accès SmartVista) ouvrent une demande préremplie. Une transaction peut être contestée en un clic : le litige est prérempli. Les adresses se règlent dans `OPS_SVIP_URL`, `OPS_P1_URL` et `OPS_COCKPIT_URL`. En production, ce sont les routes APISIX ; vides, elles pointent vers les simulateurs `sim-svip`, `sim-p1` et `sim-cockpit-lecture`.

**Tout format d'échange fournisseur est isolé dans un adaptateur réglable** : ISO 8583 dans `connectors/src/iso8583.ts` et `chargeback/mapping.ts`, Cockpit dans `connectors/src/cockpit/`, lecture dans `backend/src/operations/`. Les contrats réels s'y brancheront sans toucher au métier.

```bash
cd connectors && npm ci && npm test     # codec ISO 8583, signature des webhooks, traduction des litiges
```

## Fichiers, notifications, contenus, accès (lot 5a)

- **Fichiers** : toute pièce (demandes, litiges, mises en service, bibliothèque) est analysée par ClamAV (`zINSTREAM`) avant d'être stockée dans SeaweedFS (filer, préfixe `/apim`). Un fichier infecté est refusé et tracé dans l'audit. Si l'antivirus est indisponible, rien n'est stocké (503). Types acceptés : PDF, PNG, JPEG, TXT, CSV, DOCX, XLSX ; 3 Mo au maximum. Une banque ne voit que les pièces de ses dossiers ; les pièces d'un litige sont visibles des deux banques et de SMT. Le téléchargement se fait toujours en pièce jointe (`nosniff`).
- **Notifications** : la cloche du portail et de la console. Une banque est prévenue d'un changement d'état de ses demandes, d'une action de l'autre partie dans un litige, d'une étape de mise en service et d'une publication. Les équipes SMT reçoivent les nouvelles demandes, les validations attendues, les arbitrages, les messages ISO non accusés, et les alertes de délai (75 % et 100 %, une seule fois par niveau, vérifiées toutes les 15 minutes).
- **Contenus** (console, section Administration) : communiqués (les importants s'affichent sur l'accueil), événements, enquêtes (une réponse par utilisateur, résultats agrégés) et bibliothèque versionnée. Chaque contenu est ciblé sur toutes les banques ou une sélection.
- **Gestion des accès** : l'administrateur sécurité d'une banque gère ses utilisateurs (rôles `banque-*` seulement) ; l'administrateur SMT gère ceux de la console. Le mot de passe temporaire n'est affiché qu'une fois ; le changement de mot de passe et la double authentification sont imposés à la première connexion. On ne peut ni retirer son propre rôle d'administrateur, ni désactiver son propre compte. Le back-end passe par le compte de service Keycloak `backend-admin` (`manage-users`, `view-users`, `query-users`) ; son secret, `KEYCLOAK_BACKEND_SECRET`, est injecté dans le royaume à l'import.

## Facturation, identifiants, cahiers de tests, assistant, supervision (lot 5b)

- **Facturation globale** : chaque plan porte un tarif (abonnement mensuel et prix par appel facturable, en millimes). Les relevés d'un mois terminé sont émis depuis la console (Finance) et regroupent trois éléments : abonnements de production actifs dans le mois (sans prorata), appels facturables × prix, frais d'arbitrage des litiges perdus. L'émission est idempotente (un relevé par banque et par mois) et l'échéance est à 30 jours. La banque est notifiée et consulte ses relevés dans Consommation et facturation.
- **Rapprochement** : chaque paiement est enregistré avec sa référence de virement, sans doublon. Il est affecté à un relevé, ou laissé à rapprocher puis affecté. Le relevé est émis, partiel ou payé ; la vue de rapprochement montre aussi les retards et les trop-perçus.
- **Identifiants et sandbox** (portail, Développeurs) : la clé d'API est générée ou renouvelée par le développeur ou l'administrateur sécurité, et affichée une seule fois. Seule son empreinte est conservée. Les accès sont présentés par environnement, avec l'adresse de chaque passerelle (`PUBLIC_GATEWAY_URL`, `PUBLIC_SANDBOX_URL`).
- **Cahiers de tests** (console, Catalogue) : les cas types d'un service (obligatoires ou non, versionnés) sont recopiés automatiquement à l'entrée en sandbox de chaque mise en service.
- **Assistant** (option) : il répond à partir de la bibliothèque, des contenus et du catalogue visibles de la banque, en citant ses sources. Les numéros de carte sont retirés avant tout traitement, et l'assistant ne reçoit jamais de données de transaction ; il est limité à 20 questions par heure et par utilisateur. Avec `ASSISTANT_URL`, il interroge un modèle open source hébergé sur site (API « chat completions ») ; sans modèle, ou si le modèle est indisponible, il renvoie les extraits.
- **Paramètres et supervision** (console, Administration) : état de la base, de Valkey, d'APISIX, de ClamAV, de SeaweedFS, de l'annuaire Keycloak et des fournisseurs ; messages en attente ou en échec ; réglages en vigueur.

## Front-end (lot 3)

`frontend/` contient deux applications React (Vite, TypeScript) et une bibliothèque commune :

- `ui/` : charte des maquettes (polices auto-hébergées), composants, client HTTP, connexion Keycloak, libellés français ;
- `portail/` : accueil, demandes, litiges, mises en service, catalogue, consommation et abonnements ;
- `console/` : tableau de bord, file des demandes (double validation), litiges et arbitrage, mises en service, partenaires, abonnements, catalogue, plans, fournisseurs, facturation, engagements et jours fériés, journal d'audit.

Le menu reprend la structure validée ; tous ses écrans sont actifs. Le navigateur appelle `/api`, relayé vers le back-end : même origine, pas de CORS. L'adresse de Keycloak est lue au démarrage dans `/config.json` ; une même image sert tous les environnements.

```bash
cd frontend && npm ci
npm run dev:portail      # http://localhost:5174 (back-end attendu sur :3000, Keycloak sur :8081)
npm run dev:console      # http://localhost:5173
npm test                 # tests unitaires
# Parcours dans un vrai navigateur, contre le vrai back-end et le vrai Keycloak :
ADMIN_API_TOKEN=… KEYCLOAK_ADMIN_PASSWORD=… npx playwright test
```

Les parcours Playwright créent leurs propres données et utilisateurs de recette (`e2e/seed.ts`).

## Sécurité (lot 2)

- **Console** (routes `/partners`, `/requests`, `/disputes`…) : jeton Keycloak du client `console`. Chaque contrôleur déclare sa section de menu (`@Section`) et les rôles autorisés sont définis dans `backend/src/auth/roles.ts`. L'administrateur a tous les droits ; l'auditeur lit tout et n'écrit rien. La décision d'arbitrage est réservée à l'arbitre. `GET /console/me` renvoie le profil et les sections visibles.
- **Portail** (`/portal/...`) : jeton du client `portail`. La banque est lue dans l'attribut `partner_code` du jeton, jamais dans la requête. La ressource d'une autre banque répond 404. Dans un litige, le rôle (émetteur ou acquéreur) est déduit de la banque connectée. Le PV de recette n'est signé que par l'administrateur sécurité de la banque.
- **Jeton technique** (`ADMIN_API_TOKEN`) : réservé aux échanges entre services et aux scripts d'exploitation.
- **Audit** : l'auteur est l'identité Keycloak (`amel`, `BNA:op.dupont`).

Pour créer un utilisateur de banque dans Keycloak (royaume `smt`), renseignez l'attribut `partner_code` (le code de la banque, en majuscules) et attribuez-lui un rôle `banque-*`.

## Tests du back-end

```bash
cd backend && npm ci && npm test        # base sql.js et Valkey simulés
```

Recette des cas d'utilisation sur un vrai PostgreSQL et un vrai Valkey (la base indiquée est remise à zéro) :

```bash
QA_DB_URL=postgres://apiplatform:<mdp>@127.0.0.1:5432/apiplatform_qa \
QA_VALKEY_URL=redis://:<mdp>@127.0.0.1:6379 npm run test:qa
```

## Limites connues du lot 1

- Une instance de chaque service : pas de haute disponibilité (prévue au lot de mise en production).
- Schéma de base créé automatiquement (`DB_SYNCHRONIZE=true`) : migrations versionnées avant la production.
- OpenSearch n'est pas inclus (lot 5).
