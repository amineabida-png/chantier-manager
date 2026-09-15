# CHANTIER MANAGER

Application de gestion de chantiers (BTP) — clients, devis, factures, dépenses, situations de travaux, équipe, matériaux, documents, rapports et trésorerie.

PWA installable, utilisable hors-ligne (coquille applicative en cache), avec authentification, rôles (`admin`, `comptable`, `chef_chantier`) et journal d'audit. Les données sont centralisées côté serveur dans une base PostgreSQL — ce n'est plus une application 100 % locale.

Application en ligne : https://chantier-manager.up.railway.app

## Architecture

- **Frontend** : application monofichier (`index.html`), vanilla JS, sans build. PDF via `vendor/jspdf.umd.min.js`.
- **Backend** : `server.js`, Node.js + Express + PostgreSQL (`pg`), sessions par cookie signé (HMAC), mots de passe hashés (`bcryptjs`).
- **PWA** : `manifest.json` + `sw.js` (stale-while-revalidate pour la coquille ; les appels `/api/*` ne sont jamais mis en cache).

## Développement local

```bash
npm install
```

Variables d'environnement requises (voir `.env.example`) :

| Variable | Description |
|---|---|
| `DATABASE_URL` | URL de connexion PostgreSQL |
| `SESSION_SECRET` | Secret de signature des cookies de session |
| `ADMIN_USERNAME` | Identifiant du compte admin créé automatiquement au premier démarrage (si aucun utilisateur n'existe) |
| `ADMIN_PASSWORD` | Mot de passe de ce compte admin initial |
| `PORT` | Port d'écoute (optionnel, `3000` par défaut) |

```bash
cp .env.example .env   # puis renseigner les valeurs
npm start
```

Le schéma PostgreSQL (tables `chantier_manager_state`, `chantier_manager_users`, `chantier_manager_audit_log`, `chantier_manager_counters`) est créé automatiquement au démarrage (`ensureSchema`).

⚠️ `ADMIN_USERNAME`/`ADMIN_PASSWORD` ne servent qu'à l'amorçage : une fois le premier compte admin créé en base, modifier ces variables ne change plus rien pour un déploiement existant. Pour changer le mot de passe d'un compte existant, utiliser l'écran **Paramètres** de l'application (changement de mot de passe) une fois connecté.

## Déploiement (Railway)

Le service `chantier-manager` du projet Railway **practical-grace** sert l'application. Provisionner un plugin PostgreSQL sur le même projet et renseigner `DATABASE_URL`/`SESSION_SECRET`/`ADMIN_USERNAME`/`ADMIN_PASSWORD` dans les variables du service.

## Sauvegarde de la base

Voir [`scripts/backup.sh`](scripts/backup.sh) pour exporter un dump PostgreSQL (`pg_dump`) de la base de production.

## Rôles

- **admin** : accès complet, gestion des comptes, journal d'audit.
- **comptable** : accès aux modules financiers (clients, devis, factures, dépenses, situations).
- **chef_chantier** : accès restreint à `projects`, `materials`, `employees`, `documents`, `journal` — les autres collections sont masquées côté lecture et protégées côté écriture par le serveur.
