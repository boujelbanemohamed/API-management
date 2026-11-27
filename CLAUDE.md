# Plateforme API Management — SMT

Hub central et unique point d'entrée des banques vers les services SMT. La plateforme consomme les API des fournisseurs et les expose aux banques sous deux formes : des écrans dans le portail et des API. Elle gère le contrat, la mise en service, les abonnements, les quotas, la sécurité, la facturation, les engagements de service et l'audit. Elle sert aussi de back-office SMT (console).

## Contraintes non négociables
- Tout est gratuit et open source, sauf RHEL (conteneurs Podman inclus). Pas de licence AGPL qui oblige à publier le code : par exemple SeaweedFS plutôt que MinIO.
- Ne jamais stocker ni afficher un numéro de carte complet : seulement les 6 premiers et les 4 derniers chiffres (PCI-DSS).
- Les litiges ne concernent que le scheme national et sont centralisés ici : il n'existe pas d'autre portail pour cela.
- « Plateforme 1 », pas « switch ». ISO 8583 ne sert que pour les litiges (plateforme Chargeback).
- Hébergement sur site ou chez un hébergeur en Tunisie (exigence BCT).

## Architecture
Portail React → back-end NestJS (métier + BFF du portail) → APISIX → fournisseurs.
- **Fournisseurs :**
  - SVIP vers SmartVista : appels synchrones ;
  - SMT Cockpit : traitement asynchrone, retours par webhooks ;
  - plateforme Chargeback : ISO 8583 ;
  - Plateforme 1.
- **Données :**
  - PostgreSQL (Patroni) ;
  - Valkey (quotas et droits) ;
  - etcd (APISIX) ;
  - SeaweedFS + ClamAV pour les fichiers ;
  - OpenSearch.
- **Identité :** Keycloak, avec des rôles par section de menu et une double validation pour les opérations sensibles.
- **Environnements :** recette, sandbox (simulateurs uniquement), production.

## Où trouver quoi
- Maquettes : artifact canvas 37ceae13-023d-41e4-ab1a-a3f5b7a19c0a.
- Architecture : whiteboard bdca7a9f-047e-40b9-8336-b5372fdc1368.
- Spécifications fonctionnelles : doc f2da5252-df83-4625-aff7-45284f5c25ed, sections 1 à 15. Les fonctions sont numérotées F-ADM, F-POR, F-DEM, F-MES, F-LIT, F-OPS, F-CON, F-ROL et F-FAC.
- `backend/` : NestJS 11 + TypeORM, avec ces modules :
  - partners, providers, apis, plans, subscriptions ;
  - gateway (synchronisation APISIX, Valkey), usage, audit ;
  - requests, onboarding, disputes ;
  - auth (vérification des jetons Keycloak, gardes `ConsoleGuard` et `PortalGuard`, droits par section dans `auth/roles.ts`) ;
  - portal (BFF du portail : la banque vient toujours du jeton, la ressource d'une autre banque répond 404).
- Règles métier en fonctions pures : `*-rules.ts`. Calendrier tunisien : `common/working-days.ts`.
- `gateway/apisix/plugins/` : plugins Lua.
- `backend/src/integration/` : bus (RabbitMQ ou mémoire), relais outbox, réception idempotente (`Inbox`). Sujets dans `message-bus.ts` (TOPICS). Une action qui doit partir vers un fournisseur appelle `enqueue(manager, topic, payload)` dans sa transaction.
- `backend/src/operations/` : adaptateur de lecture des fournisseurs (`OperationsClient`, adresses `OPS_*_URL`), filtre sur la banque du jeton et masquage des cartes (`ownOnly`, `maskDeep`) appliqués à toute donnée fournisseur.
- `backend/src/billing/` (relevés, paiements, `billing-rules.ts`), `assistant/` (`ASSISTANT_URL`), `supervision/` ; cahiers de tests : `TestBook` dans `onboarding/`.
- `backend/src/files/` (`storage.ts` : `SeaweedFilerStore`, `ClamdScanner`), `notifications/`, `contents/`, `users/` (`KeycloakDirectory`).
- `connectors/` : connecteurs (`chargeback/`, `cockpit/`) et simulateurs (`sim/`), Node 22 TypeScript, une image ; codec `iso8583.ts`.
- `frontend/` : npm workspaces `ui` (charte, composants, client HTTP, Keycloak), `portail`, `console` ; parcours `e2e/` (Playwright, `CHROME_PATH` pour un Chrome local). Les droits d'écriture côté écran (`session.tsx`) reprennent `backend/src/auth/roles.ts` : les garder alignés.

## Conventions
- Code et commentaires en français. Dates métier au format `AAAA-MM-JJ`, heure de Tunis, avec une horloge injectable (`FixedClock` dans les tests).
- Erreurs métier : `BusinessRuleError(code, message)` → HTTP 409 `{ statusCode, code, message }`.
- Chaque action est tracée dans l'audit, avec son auteur.
- Tests : Jest. Les tests de bout en bout tournent sur sql.js en mémoire, avec une passerelle et Valkey simulés. Lancer `npm test` dans `backend/`. Recette sur un vrai PostgreSQL et un vrai Valkey : `npm run test:qa` avec `QA_DB_URL` et `QA_VALKEY_URL`.
- Keycloak : l'attribut utilisateur `partner_code` (cloisonnement) est déclaré dans le profil utilisateur du royaume ; seul un administrateur peut le modifier.
- Règle de production : `ONBOARDING_ENFORCE` (vrai par défaut). Pas de production sans PV de recette signé par la banque et par SMT.

## Dépôt
https://github.com/boujelbanemohamed/API-management, branche `main`. Pousser seulement après la QA.

## Processus par lot (fixé par Mohamed)
1. Valider la structure avec Mohamed avant de coder.
2. Développer.
3. Faire la QA : tester l'ensemble des cas d'utilisation du lot.
4. Ajuster.
5. Pousser sur git seulement quand tout est OK.

## Lots
| Lot | Contenu | État |
|---|---|---|
| 0 | Back-end métier (partners → disputes) | Fait, 51 tests verts, poussé le 2026-11-23 |
| 1 | Socle exécutable : compose Podman, configuration APISIX, `.env`, README | Poussé. QA du 2026-11-23 sur services réels (PostgreSQL 16, Valkey, etcd, Keycloak 26, SeaweedFS, simulateur) : OK. Reste à valider sur Podman : APISIX et le parcours `deploy/scripts/qa-lot1.sh` |
| 2 | Sécurité : Keycloak, BFF, cloisonnement par banque | Fait et poussé le 2026-11-23 : 65 tests ; QA sur un vrai Keycloak 26 (jetons réels, deux banques) |
| 3 | Front React : portail et console | Fait et poussé le 2026-11-26 : 12 parcours Playwright sur vrai back-end + Keycloak, tests unitaires ; écrans des lots 4-5 marqués « Bientôt » |
| 4a | Couche d'intégration : RabbitMQ, outbox/inbox, connecteurs Chargeback (codec ISO 8583:1993 maison, jamais jPOS qui est AGPL) et Cockpit (webhooks HMAC), simulateurs | Fait et poussé le 2026-11-26 : QA sur RabbitMQ réel (pannes courtier, connecteur, plateforme ; webhooks falsifiés et rejoués) ; formats à confirmer avec les vraies spécifications |
| 4b | Simulateurs SVIP, Plateforme 1, Cockpit en lecture ; BFF `portal/operations` ; six écrans « Opérations » du portail | Fait et poussé le 2026-11-26 : 18 parcours Playwright ; interfaces supposées, réglables (Mohamed : « tout est modulable, on ajustera ») |
| 5a | Fichiers (ClamAV puis SeaweedFS), notifications, contenus (communiqués, événements, enquêtes, bibliothèque), gestion des accès (API d'administration Keycloak) | Fait et poussé le 2026-11-26 : QA sur ClamAV (EICAR), SeaweedFS et Keycloak réels ; 25 parcours Playwright |
| 5b | Facturation globale et rapprochement, identifiants et sandbox du portail, cahiers de tests, assistant IA, paramètres et supervision | Fait et poussé le 2026-11-27 : 101 tests back-end, 30 parcours Playwright ; plus aucun écran « Bientôt » |

## Reste à faire avant la production
- Recette d'APISIX et du parcours `deploy/scripts/qa-lot1.sh` sur un serveur avec Podman.
- Contrats réels des fournisseurs (SVIP, Plateforme 1, Cockpit, Chargeback ISO 8583) à brancher dans les adaptateurs.
- Noms de domaine : adresses de retour des clients Keycloak (`realm-smt.json`), `KEYCLOAK_PUBLIC_URL`, `PUBLIC_*_URL`.
- Haute disponibilité (Patroni, etcd ×3, Valkey Sentinel, APISIX ×2), migrations de base versionnées (`DB_SYNCHRONIZE=false`), OpenSearch.
