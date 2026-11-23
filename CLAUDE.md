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
  - requests, onboarding, disputes.
- Règles métier en fonctions pures : `*-rules.ts`. Calendrier tunisien : `common/working-days.ts`.
- `gateway/apisix/plugins/` : plugins Lua.

## Conventions
- Code et commentaires en français. Dates métier au format `AAAA-MM-JJ`, heure de Tunis, avec une horloge injectable (`FixedClock` dans les tests).
- Erreurs métier : `BusinessRuleError(code, message)` → HTTP 409 `{ statusCode, code, message }`.
- Chaque action est tracée dans l'audit, avec son auteur.
- Tests : Jest. Les tests de bout en bout tournent sur sql.js en mémoire, avec une passerelle et Valkey simulés. Lancer `npm test` dans `backend/`.
- Règle de production : `ONBOARDING_ENFORCE` (vrai par défaut). Pas de production sans PV de recette signé par la banque et par SMT.

## Dépôt
https://github.com/boujelbanemohamed/API-management (vide au 2026-11-23). Pousser seulement après la QA.

## Processus par lot (fixé par Mohamed)
1. Valider la structure avec Mohamed avant de coder.
2. Développer.
3. Faire la QA : tester l'ensemble des cas d'utilisation du lot.
4. Ajuster.
5. Pousser sur git seulement quand tout est OK.

## Lots
| Lot | Contenu | État |
|---|---|---|
| 0 | Back-end métier (partners → disputes) | Fait, 51 tests verts, pas encore poussé |
| 1 | Socle exécutable : compose Podman, configuration APISIX, `.env`, README | Développé ; QA de bout en bout à lancer sur un poste avec Podman (`deploy/scripts/qa-lot1.sh`) |
| 2 | Sécurité : Keycloak, BFF, cloisonnement par banque | À faire |
| 3 | Front React : console puis portail | À faire |
| 4 | Connecteurs : simulateurs puis SVIP, Cockpit, Chargeback (contrats d'API à fournir) | À faire |
| 5 | Fichiers et antivirus, notifications, contenus, facturation globale, assistant IA | À faire |
