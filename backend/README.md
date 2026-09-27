# pump.social — API (backend)

Node.js 22 · TypeScript · **Fastify** · Postgres (postgres.js, SQL brut) · MinIO/S3 ·
Solana devnet. Lancement : voir le [README racine](../README.md#backend-local-docker-desktop--windows-10).

```
src/
  server.ts            démarrage : migrations → géoloc → bucket → écoute → purge planifiée
  app.ts               Fastify : CORS, rate limit, erreurs uniformes, routes
  config.ts            toutes les variables d'env, validées au démarrage
  config/lifespan.ts   paliers de durée de vie (ajustables, miroir du frontend)
  routes/              auth, users, media, posts, pumps, leaderboard, meta (health/config/geo)
  lib/solana.ts        vérification on-chain d'un pump
  lib/aggregates.ts    compteurs dérivés (mis à jour en transaction) + reconstruction
  jobs/purge.ts        expiration & suppression réelle
migrations/            SQL versionné, appliqué au démarrage (schema_migrations)
test/                  unit.test.ts (npm test) · e2e.mjs (contre le stack lancé)
```

## Endpoints

Erreurs : `{"error": "<code>", "message": "<texte FR>"}`. Montants en SOL = chaînes
décimales exactes (`"1.600000000"`). Routes 🔒 : `Authorization: Bearer <jwt>` ;
🔒✎ : JWT **et** pseudo déjà créé.

| Méthode | Route | |
| --- | --- | --- |
| GET | `/health` | Postgres + stockage + géoloc (healthcheck Docker) |
| GET | `/config` | wallet plateforme, ratio, cluster, types/poids médias acceptés |
| GET | `/geo` | pays du visiteur (IP → pays à la volée, non stocké) |
| POST | `/auth/nonce` `{wallet}` | défi à usage unique, expire en 5 min → `{nonce, message}` |
| POST | `/auth/verify` `{wallet, message, signature}` | vérifie la signature ed25519, consomme le nonce → `{token, needs_pseudo, user}` |
| GET 🔒 | `/me` | `{wallet, user, needs_pseudo}` |
| POST 🔒 | `/users` `{pseudo}` | crée le pseudo (unique, insensible à la casse) |
| PATCH 🔒✎ | `/users/me` `{pseudo}` | change de pseudo |
| GET | `/users/:pseudo` | profil, posts actifs, `posts_count`, `expired_count` |
| POST 🔒✎ | `/media/presign` `{content_type, size}` | formulaire POST pré-signé → upload direct navigateur → MinIO |
| POST 🔒✎ | `/posts` `{texte, media_key?}` | crée le post (expiration = maintenant + 24 h) |
| GET | `/feed?cursor=&limit=` | posts non supprimés, du plus récent, pagination par curseur |
| GET | `/posts/:id` | post (tombstone s'il est purgé) + ses derniers pumps |
| POST 🔒✎ | `/pumps` `{post_id, tx_signature, amount_sol}` | vérifie la transaction on-chain puis enregistre |
| GET | `/leaderboard/posts` · `/leaderboard/creators` | `period=all\|24h\|7d\|30d`, `scope=world\|country`, `country=XX`, `cursor`, `limit` |

## Choix de conception

**Posts supprimés = tombstones.** La purge efface réellement le contenu (texte,
média dans MinIO) et pose `deleted_at`, mais la ligne `posts` reste avec son
auteur et son pays. `pumps.post_id` garde donc une clé étrangère valide
(`ON DELETE RESTRICT`), et les classements par période continuent d'afficher un
« post supprimé » s'il a reçu des pumps dans la fenêtre.

**`pumps` est append-only**, garanti par la base : des triggers rejettent
`UPDATE`, `DELETE` et `TRUNCATE`. Chaque ligne enregistre aussi le partage
vérifié on-chain (`creator_amount_sol`, `platform_amount_sol`) : le ratio est
configurable, donc on ne le recalcule jamais après coup.

**Pays.** L'IP n'est jamais stockée. À la création d'un post, le pays de
l'auteur (code ISO, déduit de son IP à cet instant) est enregistré sur le post.
C'est lui qui définit « posts / créateurs · FR ». Pour le visiteur, le pays sert
seulement de valeur par défaut du filtre, calculé à chaque requête. Base
auto-hébergée : DB-IP Lite (CC BY 4.0). Un pays « créateur » = les pumps reçus
sur ses posts publiés depuis ce pays.

**Vérification d'un pump** (`lib/solana.ts`). Rien n'est écrit avant que la
transaction soit **confirmée** et conforme :
- signée par le wallet authentifié ;
- transferts System uniquement vers le wallet du créateur du post et le wallet
  plateforme configuré ; tout autre destinataire est refusé ;
- parts exactement égales au ratio configuré (arrondi identique au frontend) ;
- total égal au montant déclaré. Le montant enregistré est celui lu on-chain,
  jamais celui déclaré par le client ;
- moins de `PUMP_MAX_TX_AGE_SECONDS` d'ancienneté, pour qu'un ancien transfert
  vers le créateur ne puisse pas être réclamé comme pump ;
- `tx_signature` unique en base (anti-rejeu, y compris en cas de requêtes
  simultanées).

La durée de vie est ensuite recalculée depuis les paliers de
`config/lifespan.ts`, et n'est jamais raccourcie.

**Classement « Tout » : pourquoi ne pas sommer toute la table.** Sommer `pumps`
depuis le début grossirait avec l'historique. Les totaux « depuis toujours »
sont donc des **compteurs dérivés** (`posts.total_pumped_sol`,
`users.total_received_sol`, `creator_country_totals`). Ils sont mis à jour
**dans la même transaction** que l'insertion du pump, et lus via un index
`(total desc, id)`, soit une ligne par post ou créateur. `pumps` reste la source
de vérité : `npm run rebuild-aggregates` recalcule tout depuis elle. Les périodes
24h/7j/30j somment `pumps` sur la fenêtre via un index couvrant sur
`created_at`. Si le volume de 30j devient important, l'étape suivante est une
table de cumuls journaliers, sans changer l'API.

**Pagination par curseur partout** (feed et classements) : curseur opaque =
clé de tri `(total, id)` ou `(created_at, id)` de la dernière ligne. Les sommes
sont en `numeric` exact, donc les ex æquo se paginent de façon stable, sans
doublon ni trou.

**Purge** (`jobs/purge.ts`, toutes les `PURGE_INTERVAL_SECONDS`) :
- posts expirés **hors top `KEEP_TOP_N`** (défaut 100) du classement « Tout »
  parmi les posts pumpés : suppression du média, puis tombstone ;
- uploads jamais rattachés à un post (après 1 h) ;
- nonces expirés.

Un verrou consultatif Postgres garantit qu'une seule instance exécute la purge.

**Uploads.** Formulaire POST pré-signé : c'est MinIO qui impose le type et la
taille maximale (la taille déclarée). La clé est rangée sous
`media/<wallet>/…`. Le post ne peut rattacher qu'un upload du même wallet, pas
encore utilisé, et dont le fichier correspond à ce qui a été annoncé.

**Auth.** Le JWT HS256 (7 jours) est renvoyé en Bearer, sans cookie
cross-origin. Il est stateless : se déconnecter = oublier le token côté client.
Le frontend le garde dans `localStorage`, donc une faille XSS pourrait le lire :
à garder en tête (CSP) avant la prod.

## Points à trancher côté produit

- **Auto-pump** : rien n'empêche un créateur de pumper son propre post. Il ne
  « paie » alors que les 30 % plateforme pour monter au classement.
- **Petits montants** : un transfert vers un wallet vide doit laisser au moins
  ~0,00089 SOL (minimum de rent Solana), sinon la transaction échoue on-chain.
  Un pump de 0,01 SOL (le plus petit bouton rapide) passe ; en dessous d'environ
  0,003 SOL, ça peut échouer si un destinataire est vide.

## Vers le VPS (session suivante)

Le compose est prêt tel quel. À ajouter ou changer :
- **Caddy** devant `api` (ex. `api.<domaine>`) et `minio` (`media.<domaine>`) ;
- dans `.env` :
  - `TRUST_PROXY=true` ;
  - `CORS_ORIGINS=https://pump-social.vercel.app` ;
  - `S3_PUBLIC_URL=https://media.<domaine>` ;
  - `AUTH_DOMAIN=<domaine>` ;
  - `DEV_DEFAULT_COUNTRY=` vide ;
  - des secrets neufs ;
- retirer le port Postgres s'il ne sert pas ;
- sauvegarder les volumes `pgdata` et `miniodata` ;
- de préférence, une clé MinIO dédiée à l'API au lieu des identifiants root.
