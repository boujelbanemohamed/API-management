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

## Front-end (lot 3)

`frontend/` contient deux applications React (Vite, TypeScript) et une bibliothèque commune :

- `ui/` : charte des maquettes (polices auto-hébergées), composants, client HTTP, connexion Keycloak, libellés français ;
- `portail/` : accueil, demandes, litiges, mises en service, catalogue, consommation et abonnements ;
- `console/` : tableau de bord, file des demandes (double validation), litiges et arbitrage, mises en service, partenaires, abonnements, catalogue, plans, fournisseurs, facturation, engagements et jours fériés, journal d'audit.

Le menu reprend la structure validée. Les écrans prévus dans un lot ultérieur (opérations, bibliothèque, assistant IA…) sont affichés avec la mention « Bientôt ». Le navigateur appelle `/api`, relayé vers le back-end : même origine, pas de CORS. L'adresse de Keycloak est lue au démarrage dans `/config.json` ; une même image sert tous les environnements.

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
