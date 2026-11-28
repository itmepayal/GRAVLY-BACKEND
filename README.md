# Cafe Mart (Gravly) — Backend Engineering Documentation

Production TypeScript backend for the Cafe Mart campus food-ordering platform serving **Students**, **Cafe Owners**, and a single **Admin**.

---

## 1. Project Overview

- **Purpose**: Manages campus cafe onboarding/approval, menu & stock control, single-cafe shopping carts, ACID-safe order lifecycle & auto-expiration, Cashfree online payments & refunds, multi-device JWT/session security, distributed Redis caching/locking, and real-time Socket.IO updates.
- **Architecture Style**: Layered Modular Express Architecture (`Router -> Middleware -> Controller -> Service -> Mongoose Model / Redis / Socket Emitter`), compiled from ESM TypeScript (`src/`) to Node.js JavaScript (`dist/`).
- **API Base Path**: `/api/v1` (mounted in `src/app/app.ts` via `src/routers/v1/index.router.ts`).
- **Entry Points**:
  - Single-process server: `src/server.ts` (`dist/server.js`)
  - Native Node.js cluster primary/workers: `src/cluster.ts` (`dist/cluster.js`)

---

## 2. Technology Stack

Exact versions verified from `BACKEND/package.json` and `BACKEND/tsconfig.json`:

| Layer              | Technology                         | Version / Setting                                                                                                  |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime            | Node.js                            | ESM (`"type": "module"`, `@types/node@^22.20.5`)                                                                   |
| Language           | TypeScript                         | `^5.9.3` (`target: ES2022`, `module/moduleResolution: Node16`, `strict: true`)                                     |
| Web Framework      | Express                            | `^5.1.0`                                                                                                           |
| Database / ODM     | MongoDB + Mongoose                 | `mongoose@^9.11.4`                                                                                                 |
| Redis (TCP + HTTP) | `ioredis` + `@upstash/redis`       | `ioredis@^6.1.0`, `@upstash/redis@^1.41.1`                                                                         |
| Real-Time          | Socket.IO + Redis Adapter          | `socket.io@^4.8.4`, `@socket.io/redis-adapter@^8.3.0`                                                              |
| Authentication     | JWT + Firebase + Google Auth       | `jsonwebtoken@^9.0.3`, `jose@^4.15.9`, `firebase-admin@^13.10.0`, `google-auth-library@^10.9.1`, `bcryptjs@^3.0.3` |
| Validation         | Zod + Custom Controller Validators | `zod@^3.24.2`                                                                                                      |
| Media Storage      | Cloudinary + Multer                | `cloudinary@^2.11.0`, `multer@^2.5.0`                                                                              |
| API Docs           | Swagger JSDoc + Swagger UI Express | `swagger-jsdoc@^6.3.0`, `swagger-ui-express@^5.0.1`                                                                |
| Logging            | Winston + Daily Rotate File        | `winston@^3.17.0`, `winston-daily-rotate-file@^5.0.0`                                                              |
| Security Headers   | Helmet + CORS                      | `helmet@^8.3.0`, `cors@^2.8.6`                                                                                     |
| Payments           | Cashfree PG API (`2023-08-01`)     | Native `fetch` + HMAC-SHA256 webhook verification                                                                  |

---

## 3. Project Folder Structure

```text
BACKEND/
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts                  # HTTP + DB + Redis + Socket.IO + Jobs bootstrap & graceful shutdown
│   ├── cluster.ts                 # Multi-worker Node cluster manager
│   ├── app/
│   │   └── app.ts                 # Express app, Helmet, CORS, Request ID, AsyncLocalStorage log context, Swagger, /health, /ready, /live, 404 & error handlers
│   ├── config/
│   │   ├── index.ts               # Fail-fast env validation & serverConfig
│   │   ├── db.config.ts           # MongoDB connection, topology check, runWithOptionalTransaction()
│   │   ├── redis.config.ts        # Native TCP + Upstash REST Redis initialization & health
│   │   ├── logger.config.ts       # Winston logger, securityAuditLogger, sanitizeLogData(), flushLoggers()
│   │   ├── swagger.config.ts      # OpenAPI 3.0.3 spec + component schemas/responses
│   │   ├── cloudinary.config.ts   # Public/private uploads, signed URLs (60-3600s TTL), secret redaction
│   │   └── cashfree.config.ts     # Cashfree PG API client, timeouts, HMAC webhook verification
│   ├── routers/v1/
│   │   ├── index.router.ts        # Mounts /auth, /cafes, /menu, /cart, /orders, /payments, /admin
│   │   ├── auth.router.ts
│   │   ├── cafe.router.ts
│   │   ├── menu.router.ts
│   │   ├── cart.router.ts
│   │   ├── order.router.ts
│   │   ├── payment.router.ts
│   │   └── admin.router.ts
│   ├── controllers/               # HTTP request parsing, param/body validation, response formatting
│   ├── service/                   # Core business logic, Mongoose transactions, cache invalidation, socket emit
│   ├── models/                    # 10 Mongoose schemas + indexes
│   ├── middlewares/
│   │   ├── authenticate.middleware.ts # JWT/session/revocation check, Redis/memory user cache, role authorize()
│   │   ├── rateLimiter.middleware.ts  # Redis sliding-window Lua rate limiters with progressive cooldowns
│   │   ├── upload.middleware.ts       # Multer memoryStorage (5 MB, max 16 files) + magic-byte JPEG/PNG/WEBP check
│   │   └── error.middleware.ts        # Centralized AppError/Mongo/JWT/Multer/Zod HTTP error mapping
│   ├── infrastructure/redis/      # Hybrid TCP/REST executor, circuit breaker, locks, idempotency, keys, metrics
│   ├── socket/                    # Socket.IO server, JWT handshake auth, room auth, ZSET presence, emitters, revocation
│   ├── job/
│   │   ├── index.ts               # Primary-worker scheduler, distributed locks, retry/DLQ
│   │   └── order.job.ts           # expireUnpaidOrders (cancels >20m unpaid online orders & releases stock)
│   ├── validators/index.ts        # Generic Zod body/query validation helpers (currently imported only if mounted)
│   └── utils/                     # errors/app.error.ts, jwt/jwt.ts, order/requestUser.ts, password/password.ts, session/device.util.ts
└── tests/                         # Node native integration tests (swagger, cafe-availability, socket-realtime, auth-logger-unit)
```

---

## 4. Backend Architecture

### Middleware Order (`src/app/app.ts`)

1. `app.disable("x-powered-by")` and `app.set("trust proxy", resolveTrustProxy())`
2. Request Correlation (`X-Request-ID`) + HTTP timing logger + `runWithLogContext(...)`
3. Strict Helmet CSP & security headers (`frameguard: deny`, `noSniff`, HSTS in production)
4. Infrastructure probes: `GET /health`, `GET /ready`, `GET /live`
5. `cors(corsOptions)` & preflight `OPTIONS /.*/`
6. `express.json({ limit: "1mb" })` preserving `req.rawBody` for Cashfree HMAC webhook verification
7. Swagger UI (`/docs`, `/docs/`) and OpenAPI JSON (`/docs-json`) unless `ENABLE_SWAGGER=false`
8. API Router: `app.use("/api/v1", v1Router)`
9. Global Catch-All 404: `next(new NotFoundError("Route not found"))`
10. Error pipeline: `multerErrorHandler -> appErrorHandler -> genericErrorHandler`

---

## 5. Installation and Setup

### Prerequisites

- Node.js `>= 20`
- MongoDB (Replica Set recommended for multi-document ACID transactions; standalone MongoDB falls back gracefully via `runWithOptionalTransaction()`)
- Redis (`redis-server` for native TCP adapter/Pub/Sub and/or Upstash Redis REST)

### Commands (matching `BACKEND/package.json`)

```bash
cd BACKEND
npm install
cp .env.example .env
# Edit .env with local/test credentials

# Development hot-reload server (tsx watch)
npm run dev

# TypeScript typecheck
npm run typecheck

# Compile src/ -> dist/
npm run build

# Production single process
npm start

# Production multi-worker cluster
npm run start:cluster

# Run automated test suites sequentially
npm test
```

### Local MongoDB Replica Set Setup (Optional, Enables Real Transactions)

```bash
mongod --port 27017 --dbpath /data/db --replSet rs0
mongosh --eval "rs.initiate()"
```

---

## 6. Environment Variables

All required variables are validated at startup in `src/config/index.ts`. Do not commit real secrets.

| Variable                                                                                          | Purpose                                                              | Required                                 | Example                                      |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `NODE_ENV`                                                                                        | Runtime mode (`development` / `production`)                          | No (default `development`)               | `production`                                 |
| `PORT`                                                                                            | HTTP & Socket.IO server port                                         | No (default `8000`)                      | `8000`                                       |
| `TRUST_PROXY`                                                                                     | Express proxy hop setting (`false`, `true`, number, CIDR)            | No (default `false`)                     | `1`                                          |
| `ENABLE_SWAGGER`                                                                                  | Set `false` to disable `/docs` and `/docs-json`                      | No (enabled unless `false`)              | `true`                                       |
| `SWAGGER_REQUIRE_AUTH`                                                                            | Require admin JWT or `X-Swagger-Key` for `/docs`                     | No                                       | `false`                                      |
| `SWAGGER_ACCESS_KEY`                                                                              | Optional static access key (`>=16` chars) in `X-Swagger-Key`         | No                                       | `<min-16-char-key>`                          |
| `MONGODB_URI`                                                                                     | MongoDB connection URI                                               | **Yes**                                  | `mongodb+srv://<user>:<pass>@<cluster>/<db>` |
| `DB_MAX_POOL_SIZE`                                                                                | Mongoose connection pool size                                        | No (default `200`)                       | `200`                                        |
| `CLUSTER_MODE`                                                                                    | Cluster indicator flag                                               | No (`false`)                             | `false`                                      |
| `CLUSTER_WORKERS` / `WEB_CONCURRENCY`                                                             | Worker count for `dist/cluster.js`                                   | No (CPU parallelism)                     | `2`                                          |
| `JWT_ACCESS_SECRET`                                                                               | HMAC secret for access JWTs                                          | **Yes**                                  | `<64-byte-hex-secret>`                       |
| `JWT_ACCESS_EXPIRES`                                                                              | Access JWT lifetime                                                  | No (`15m`)                               | `15m`                                        |
| `JWT_REFRESH_SECRET`                                                                              | HMAC secret for refresh JWTs                                         | **Yes**                                  | `<different-64-byte-hex-secret>`             |
| `JWT_REFRESH_EXPIRES`                                                                             | Refresh JWT lifetime                                                 | No (`30d`)                               | `30d`                                        |
| `JWT_ISSUER`                                                                                      | Expected JWT `iss` claim                                             | No (`cafemart-api`)                      | `cafemart-api`                               |
| `JWT_AUDIENCE`                                                                                    | Expected JWT `aud` claim                                             | No (`cafemart-client`)                   | `cafemart-client`                            |
| `BCRYPT_COST`                                                                                     | Bcrypt salt rounds (`10..14`)                                        | No (`12`)                                | `12`                                         |
| `SESSION_IDLE_TIMEOUT_MS`                                                                         | Idle session expiry window                                           | No (`7d` in ms)                          | `604800000`                                  |
| `SESSION_ACTIVITY_THROTTLE_SEC`                                                                   | Min seconds between `lastActivityAt` writes                          | No (`60`)                                | `60`                                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                                       | Google OAuth credentials                                             | **Yes**                                  | `<google-client-id>`                         |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID`                                              | Apple Sign-In identifiers                                            | **Yes**                                  | `<apple-ids>`                                |
| `CLIENT_URL`                                                                                      | Frontend base URL (used for CORS fallback & Cashfree return URL)     | **Yes**                                  | `https://app.example.com`                    |
| `CORS_ORIGIN`                                                                                     | Comma-separated allowed origins (`*` forbidden)                      | **Yes**                                  | `https://app.example.com`                    |
| `API_BASE_URL`                                                                                    | Canonical API base URL                                               | **Yes**                                  | `https://api.example.com/api/v1`             |
| `SERVER_URL`                                                                                      | Public backend origin (used for Cashfree webhook `notify_url`)       | **Yes**                                  | `https://api.example.com`                    |
| `REDIS_URL` / `UPSTASH_REDIS_URL`                                                                 | Native TCP Redis URL (`rediss://` required in non-local prod)        | No (needed for Socket adapter & Pub/Sub) | `rediss://default:<pass>@<host>:6379`        |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`                                             | Upstash HTTP REST pair (must both be set if used)                    | No                                       | `https://<db>.upstash.io`                    |
| `REDIS_HOST` / `PORT` / `USERNAME` / `PASSWORD` / `TLS`                                           | Discrete TCP overrides when `REDIS_URL` omitted                      | No                                       | `127.0.0.1` / `6379`                         |
| `REDIS_TLS_REJECT_UNAUTHORIZED`                                                                   | Verify TLS certs on TCP Redis (`false` only if needed)               | No (`true`)                              | `true`                                       |
| `REDIS_REVOCATION_FAIL_CLOSED`                                                                    | Return `503` on protected auth/limiters when Redis is down           | No (`true`)                              | `true`                                       |
| `REDIS_COMMAND_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS` / `REST_TIMEOUT_MS` / `MAX_RETRIES_PER_REQUEST` | Redis client timeouts & retries                                      | No (`2000`/`5000`/`3000`/`2`)            | `2000`                                       |
| `SOCKET_TRANSPORTS`                                                                               | Comma-separated Socket.IO transports                                 | No (`websocket,polling`)                 | `websocket,polling`                          |
| `SOCKET_PING_INTERVAL_MS` / `PING_TIMEOUT_MS`                                                     | Socket heartbeat timing                                              | No (`25000`/`20000`)                     | `25000`                                      |
| `SOCKET_MAX_CONNECTIONS_PER_USER`                                                                 | Max simultaneous sockets per account (`1..500`)                      | No (`25`)                                | `25`                                         |
| `CLOUDINARY_NAME` / `API_KEY` / `API_SECRET`                                                      | Cloudinary SDK credentials                                           | **Yes**                                  | `<cloud-creds>`                              |
| `CASHFREE_APP_ID` / `SECRET_KEY` / `ENV`                                                          | Cashfree PG credentials (`SANDBOX` or `PRODUCTION`)                  | **Yes**                                  | `<cashfree-creds>`                           |
| `ADMIN_REGISTER_SECRET`                                                                           | Secret required by `POST /api/v1/auth/admin/register` (`>=16` chars) | **Yes**                                  | `<high-entropy-secret>`                      |
| `ALLOW_ADMIN_REGISTRATION`                                                                        | Set `false` to block admin registration endpoint                     | No (`true`)                              | `false`                                      |
| `FIREBASE_PROJECT_ID` / `CLIENT_EMAIL` / `PRIVATE_KEY`                                            | Firebase Admin SDK credentials for Google/Apple token verify         | **Yes**                                  | `<firebase-service-account>`                 |
| `JOB_SCHEDULER_ENABLED`                                                                           | Set `false` to disable background cron jobs on a worker              | No (`true`)                              | `true`                                       |
| `LOG_LEVEL` / `LOG_TO_FILE` / `LOG_DIR`                                                           | Winston log verbosity & daily file rotation                          | No (`info` prod, `debug` dev)            | `info`                                       |
| `MEMORY_WARN_MB` / `SHUTDOWN_DRAIN_DELAY_MS`                                                      | RSS memory warning threshold & pre-close drain delay                 | No (`768` MB / `0` ms)                   | `768`                                        |

---

## 7. Application Startup

Boot sequence in `src/server.ts`:

1. Loads & validates env vars via `src/config/index.ts`.
2. Connects MongoDB via `connectDB()` (`src/config/db.config.ts`).
3. Initializes Redis TCP and/or Upstash REST via `initRedis()` (`src/config/redis.config.ts`).
4. Builds Express app via `createApp()` and wraps in Node `http.Server` (`keepAliveTimeout = 65s`, `headersTimeout = 66s`, `requestTimeout = 30s`).
5. Attaches Socket.IO and `@socket.io/redis-adapter` + auth revocation Pub/Sub via `initSocketServer(httpServer)`.
6. Binds `0.0.0.0:PORT` and emits PM2 `"ready"` IPC signal if `process.send` is present.
7. Starts background jobs on primary worker via `startBackgroundJobs()`.
8. Starts 30s RSS memory monitor and attaches `SIGTERM`, `SIGINT`, `unhandledRejection`, and `uncaughtException` handlers.

---

## 8. API Documentation

Interactive Swagger UI is served at **`/docs/`** (`GET /docs` redirects `301` to `/docs/`, and `GET /docs-json` serves the OpenAPI `3.0.3` specification with `Local Development Server` `http://localhost:8000/api/v1` and `Production Server` `https://gravly-backend-api.onrender.com/api/v1`).

**Standard Success Envelope**: `{ success: true, message: string, data?: ..., pagination?: ... }`  
**Standard Error Envelope**: `{ success: false, message: string, requestId?: string, errors?: any, stack?: string }` (`errors` & `stack` omitted when `NODE_ENV === "production"`).

### System & Docs Routes

| Method | Path               | Auth                                                                      | Purpose                                              | Status Codes                         |
| ------ | ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| `GET`  | `/health`          | Public                                                                    | DB, Redis & Socket diagnostic status                 | `200`, `503`                         |
| `GET`  | `/ready`           | Public                                                                    | Readiness probe (DB, fail-closed Redis, drain state) | `200`, `503`                         |
| `GET`  | `/live`            | Public                                                                    | Process liveness probe                               | `200`                                |
| `GET`  | `/docs` / `/docs/` | Public (or guarded if `SWAGGER_ACCESS_KEY` / `SWAGGER_REQUIRE_AUTH=true`) | Swagger UI HTML/assets                               | `301` (`/docs`), `200`, `401`, `403` |
| `GET`  | `/docs-json`       | Same as `/docs`                                                           | OpenAPI `3.0.3` JSON spec                            | `200`, `401`, `403`                  |

### Complete `/api/v1` Endpoint Reference (62 Operations)

#### Authentication (`/api/v1/auth`)

| Method   | Endpoint                           | Auth / Role              | Request Body / Params                       | Response `data`                                               | Status Codes                             |
| -------- | ---------------------------------- | ------------------------ | ------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `POST`   | `/api/v1/auth/google`              | Public                   | `{ idToken }`                               | `AuthResponse` (`accessToken, refreshToken, tokenType, user`) | `200`, `400`, `401`, `403`, `409`, `429` |
| `POST`   | `/api/v1/auth/apple`               | Public                   | `{ identityToken, fullName? }` (`max 200`)  | `AuthResponse`                                                | `200`, `400`, `401`, `403`, `409`, `429` |
| `POST`   | `/api/v1/auth/cafe-owner/google`   | Public                   | `{ idToken }`                               | `CafeOwnerAuthResponse` (+ `isApproved, approvalStatus`)      | `200`, `400`, `401`, `403`, `409`, `429` |
| `POST`   | `/api/v1/auth/cafe-owner/apple`    | Public                   | `{ identityToken, fullName? }`              | `CafeOwnerAuthResponse` (+ `isApproved, approvalStatus`)      | `200`, `400`, `401`, `403`, `409`, `429` |
| `POST`   | `/api/v1/auth/admin/register`      | Secret key               | `{ name, email, password (min 8), secret }` | `201` `AuthResponse`                                          | `201`, `400`, `403`, `409`, `429`        |
| `POST`   | `/api/v1/auth/admin/login`         | Public (`admin` account) | `{ email, password }`                       | `AuthResponse`                                                | `200`, `400`, `401`, `403`, `429`        |
| `POST`   | `/api/v1/auth/refresh-token`       | Public (refresh JWT)     | `{ refreshToken }`                          | `AuthResponse` (rotated pair)                                 | `200`, `400`, `401`, `403`, `429`        |
| `POST`   | `/api/v1/auth/logout`              | Bearer / Any user        | `{ refreshToken }`                          | `{ success, message }`                                        | `200`, `400`, `401`, `429`               |
| `POST`   | `/api/v1/auth/logout-all`          | Bearer / Any user        | None                                        | `{ revokedSessions }`                                         | `200`, `400`, `401`, `429`               |
| `GET`    | `/api/v1/auth/sessions`            | Bearer / Any user        | Query: `page?`, `limit?` (`max 50`)         | `{ sessions: SessionView[], pagination: PagePagination }`     | `200`, `401`, `429`                      |
| `GET`    | `/api/v1/auth/sessions/current`    | Bearer / Any user        | None                                        | `SessionView`                                                 | `200`, `401`, `404`, `429`               |
| `DELETE` | `/api/v1/auth/sessions/:sessionId` | Bearer / Any user        | Path: `sessionId`                           | `{ sessionId, status, alreadyRevoked }`                       | `200`, `400`, `401`, `404`, `429`        |

#### Cafes (`/api/v1/cafes`)

| Method  | Endpoint                          | Auth / Role          | Request Body / Params                                            | Response `data`                                  | Status Codes                                    |
| ------- | --------------------------------- | -------------------- | ---------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `GET`   | `/api/v1/cafes`                   | Public               | Query: `city?`, `search?`, `page?`, `limit?` (`max 100`)         | `CafePublicSummary[]` + `pagination (pages)`     | `200`, `400`, `429`                             |
| `GET`   | `/api/v1/cafes/:id`               | Public               | Path: `id` (ObjectId)                                            | `CafePublicDetail`                               | `200`, `400`, `404`, `429`                      |
| `GET`   | `/api/v1/cafes/:cafeId/menu`      | Public               | Path: `cafeId`, Query: `onlyOrderable?`                          | `PublicMenu` (`{ cafe, menu[] }`)                | `200`, `400`, `404`, `429`                      |
| `GET`   | `/api/v1/cafes/me`                | Bearer / `cafeOwner` | None                                                             | `MyCafe` (`{ status, rejectionReason, cafe }`)   | `200`, `401`, `403`, `429`                      |
| `POST`  | `/api/v1/cafes`                   | Bearer / `cafeOwner` | `multipart/form-data` (`CafeApplicationInput`, 4 mandatory docs) | `201` `CafeOwnerView`                            | `201`, `400`, `401`, `403`, `409`, `429`        |
| `PATCH` | `/api/v1/cafes/owner/open-status` | Bearer / `cafeOwner` | `{ isOpen: boolean }` _(cafe resolved from `req.user._id`)_      | `CafeOpenStatus` (`{ _id, name, isOpen }`)       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `GET`   | `/api/v1/cafes/admin`             | Bearer / `admin`     | Query: `status?`, `page?`, `limit?` (`max 100`)                  | `CafeAdminSummary[]` + `pagination`              | `200`, `400`, `401`, `403`, `429`               |
| `GET`   | `/api/v1/cafes/admin/pending`     | Bearer / `admin`     | Query: `page?`, `limit?` (`max 50`)                              | Pending cafe array + signed doc URLs             | `200`, `400`, `401`, `403`, `429`               |
| `GET`   | `/api/v1/cafes/admin/:id`         | Bearer / `admin`     | Path: `id`                                                       | `CafeAdminDetail` (sensitive KYC + signed docs)  | `200`, `400`, `401`, `403`, `404`, `429`        |
| `PATCH` | `/api/v1/cafes/admin/:id/approve` | Bearer / `admin`     | Path: `id`                                                       | `{ _id, name, approvalStatus, code }`            | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH` | `/api/v1/cafes/admin/:id/reject`  | Bearer / `admin`     | Path: `id`, Body: `{ reason }` (`1..500` chars)                  | `{ _id, name, approvalStatus, rejectionReason }` | `200`, `400`, `401`, `403`, `404`, `409`, `429` |

#### Menu (`/api/v1/menu`)

| Method   | Endpoint                        | Auth / Role          | Request Body / Params                                                                                                            | Response `data`           | Status Codes                                    |
| -------- | ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| `POST`   | `/api/v1/menu`                  | Bearer / `cafeOwner` | `multipart/form-data`: `name`, `price`, `category?`, `description?`, `isVeg?`, `isAvailable?`, `trackStock?`, `stock?`, `image?` | `201` `MenuItemOwnerView` | `201`, `400`, `401`, `403`, `404`, `409`, `429` |
| `GET`    | `/api/v1/menu/me`               | Bearer / `cafeOwner` | Query: `category?`, `availability?`, `search?`                                                                                   | `MenuItemOwnerView[]`     | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH`  | `/api/v1/menu/:id`              | Bearer / `cafeOwner` | `multipart/form-data` partial fields + `image?`                                                                                  | `MenuItemOwnerView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH`  | `/api/v1/menu/:id/availability` | Bearer / `cafeOwner` | `{ isAvailable: boolean }`                                                                                                       | `MenuItemOwnerView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH`  | `/api/v1/menu/:id/stock`        | Bearer / `cafeOwner` | `{ stock?: integer >=0, adjust?: non-zero int, trackStock?: bool }`                                                              | `MenuItemOwnerView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH`  | `/api/v1/menu/:id/stock-status` | Bearer / `cafeOwner` | `{ inStock: boolean, stock?: integer >=1 }`                                                                                      | `MenuItemOwnerView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `DELETE` | `/api/v1/menu/:id`              | Bearer / `cafeOwner` | Path: `id`                                                                                                                       | `{ _id, name }`           | `200`, `400`, `401`, `403`, `404`, `409`, `429` |

#### Cart (`/api/v1/cart`)

| Method   | Endpoint                         | Auth / Role        | Request Body / Params                                             | Response `data`  | Status Codes                                    |
| -------- | -------------------------------- | ------------------ | ----------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| `GET`    | `/api/v1/cart`                   | Bearer / `student` | None                                                              | `CartView`       | `200`, `401`, `403`, `429`                      |
| `DELETE` | `/api/v1/cart`                   | Bearer / `student` | None                                                              | Empty `CartView` | `200`, `401`, `403`, `429`                      |
| `POST`   | `/api/v1/cart/items`             | Bearer / `student` | `{ menuItemId, quantity? (1..20), replaceCart?: bool }`           | `CartView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH`  | `/api/v1/cart/items/:menuItemId` | Bearer / `student` | Path: `menuItemId`, Body: `{ quantity (0..20) }`                  | `CartView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `DELETE` | `/api/v1/cart/items/:menuItemId` | Bearer / `student` | Path: `menuItemId`                                                | `CartView`       | `200`, `400`, `401`, `403`, `404`, `429`        |
| `PATCH`  | `/api/v1/cart/options`           | Bearer / `student` | `{ orderMethod?, paymentMethod?, orderNotes?, deliveryAddress? }` | `CartView`       | `200`, `400`, `401`, `403`, `404`, `409`, `429` |

#### Orders (`/api/v1/orders`)

| Method  | Endpoint                              | Auth / Role          | Request Body / Headers / Params                                  | Response `data`        | Status Codes                                    |
| ------- | ------------------------------------- | -------------------- | ---------------------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| `POST`  | `/api/v1/orders`                      | Bearer / `student`   | Header: `Idempotency-Key?`                                       | `201` `OrderView`      | `201`, `400`, `401`, `403`, `404`, `409`, `429` |
| `GET`   | `/api/v1/orders`                      | Bearer / `student`   | Query: `type?` (`active`/`history`), `page?`, `limit?` (`<=50`)  | `OrderListView`        | `200`, `400`, `401`, `403`, `429`               |
| `GET`   | `/api/v1/orders/:orderId`             | Bearer / `student`   | Path: `orderId`                                                  | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `429`        |
| `PATCH` | `/api/v1/orders/:orderId/cancel`      | Bearer / `student`   | Path: `orderId`                                                  | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `GET`   | `/api/v1/orders/cafe`                 | Bearer / `cafeOwner` | Query: `status?`, `page?`, `limit?` (`<=50`)                     | `OrderListView`        | `200`, `400`, `401`, `403`, `404`, `429`        |
| `GET`   | `/api/v1/orders/cafe/summary`         | Bearer / `cafeOwner` | None                                                             | `CafeOrderSummaryView` | `200`, `401`, `403`, `404`, `429`               |
| `GET`   | `/api/v1/orders/cafe/history`         | Bearer / `cafeOwner` | Query: `page?`, `limit?` (`<=50`)                                | `CafeOrderHistoryView` | `200`, `400`, `401`, `403`, `404`, `429`        |
| `GET`   | `/api/v1/orders/cafe/:orderId`        | Bearer / `cafeOwner` | Path: `orderId`                                                  | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `429`        |
| `PATCH` | `/api/v1/orders/cafe/:orderId/accept` | Bearer / `cafeOwner` | Path: `orderId`                                                  | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH` | `/api/v1/orders/cafe/:orderId/reject` | Bearer / `cafeOwner` | Path: `orderId`, Body: `{ reason? (3..200) }`                    | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `PATCH` | `/api/v1/orders/cafe/:orderId/status` | Bearer / `cafeOwner` | Path: `orderId`, Body: `{ status: preparing\|ready\|delivered }` | `OrderView`            | `200`, `400`, `401`, `403`, `404`, `409`, `429` |

#### Payments (`/api/v1/payments`)

| Method | Endpoint                           | Auth / Role        | Request Body / Headers / Params                                     | Response `data`                                                                                         | Status Codes                                    |
| ------ | ---------------------------------- | ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `POST` | `/api/v1/payments/initiate`        | Bearer / `student` | Header: `Idempotency-Key?`, Body: `{ orderId }`                     | `{ paymentId, orderId, orderNumber, amount, currency, cashfreeOrderId, paymentSessionId, environment }` | `200`, `400`, `401`, `403`, `404`, `409`, `429` |
| `GET`  | `/api/v1/payments/status/:orderId` | Bearer / `student` | Path: `orderId`                                                     | `{ orderId, orderStatus, paymentMethod, paymentStatus, payment }`                                       | `200`, `400`, `401`, `403`, `404`, `429`        |
| `POST` | `/api/v1/payments/webhook`         | Cashfree HMAC      | Headers: `x-webhook-timestamp`, `x-webhook-signature`, JSON payload | `{ success: true }`                                                                                     | `200`, `400`, `429`                             |

#### Admin (`/api/v1/admin`)

| Method  | Endpoint                                      | Auth / Role      | Request / Query / Path                                                                                                                  | Response `data`                                                                                  | Status Codes                             |
| ------- | --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `GET`   | `/api/v1/admin/dashboard`                     | Bearer / `admin` | None (cached 15s in Redis)                                                                                                              | `{ totalRevenue, totalOrders, activeNow, openCafes, allUsers, usersBreakdown, newCafeRequests }` | `200`, `401`, `403`, `429`               |
| `GET`   | `/api/v1/admin/users`                         | Bearer / `admin` | Query: `page?`, `limit?`, `role?`, `isActive?`, `search?`                                                                               | `{ users, pagination (totalPages) }`                                                             | `200`, `400`, `401`, `403`, `429`        |
| `GET`   | `/api/v1/admin/users/:userId`                 | Bearer / `admin` | Path: `userId`                                                                                                                          | `{ user, profile, stats }`                                                                       | `200`, `400`, `401`, `403`, `404`, `429` |
| `PATCH` | `/api/v1/admin/users/:userId/status`          | Bearer / `admin` | Path: `userId`, Body: `{ isActive: boolean }`                                                                                           | `AdminUser`                                                                                      | `200`, `400`, `401`, `403`, `404`, `429` |
| `POST`  | `/api/v1/admin/users/:userId/revoke-sessions` | Bearer / `admin` | Path: `userId`                                                                                                                          | `{ revokedSessions }`                                                                            | `200`, `400`, `401`, `403`, `404`, `429` |
| `GET`   | `/api/v1/admin/orders`                        | Bearer / `admin` | Query: `page?`, `limit?`, `from?`, `to?`, `status?`, `paymentStatus?`, `paymentMethod?`, `orderMethod?`, `cafe?`, `student?`, `search?` | `{ orders, pagination }`                                                                         | `200`, `400`, `401`, `403`, `429`        |
| `GET`   | `/api/v1/admin/orders/:orderId`               | Bearer / `admin` | Path: `orderId`                                                                                                                         | Populated order + student + cafe + payment                                                       | `200`, `400`, `401`, `403`, `404`, `429` |
| `GET`   | `/api/v1/admin/payments`                      | Bearer / `admin` | Query: `page?`, `limit?`, `from?`, `to?`, `status?`, `method?`, `settlementStatus?`, `cafe?`, `student?`, `search?`                     | `{ summary, payments, pagination }`                                                              | `200`, `400`, `401`, `403`, `429`        |
| `GET`   | `/api/v1/admin/payments/:paymentId`           | Bearer / `admin` | Path: `paymentId` (ObjectId or `pay_*`)                                                                                                 | Payment detail incl. `gatewayResponse`                                                           | `200`, `400`, `401`, `403`, `404`, `429` |
| `GET`   | `/api/v1/admin/profile`                       | Bearer / `admin` | None                                                                                                                                    | `AdminUser`                                                                                      | `200`, `401`, `403`, `404`, `429`        |
| `PATCH` | `/api/v1/admin/profile`                       | Bearer / `admin` | `{ name?, phone?, profileImage? }` (`>=1` field)                                                                                        | `AdminUser`                                                                                      | `200`, `400`, `401`, `403`, `404`, `429` |
| `PATCH` | `/api/v1/admin/change-password`               | Bearer / `admin` | `{ currentPassword, newPassword (8..128) }`                                                                                             | `{ success: true, message }`                                                                     | `200`, `400`, `401`, `403`, `404`, `429` |

#### Reviews / Standalone User & Student CRUD Routes

- **NOT IMPLEMENTED**: No Express routes exist for `/reviews`, `/users`, or `/students` beyond Auth (`socialLogin`), Order/Cart student resolution (`studentIdentityOf`), and Admin read/moderation endpoints.

---

## 9. Database Architecture

All 10 Mongoose models under `BACKEND/src/models/`:

| Model          | Collection      | Key Fields, Constraints & Indexes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`         | `users`         | `name`, `email` (unique, lowercase), `password?` (`select: false`), `authProvider` (`google\|apple\|password`), `providerId?`, `role` (`student\|admin\|cafeOwner`, default `student`), `profileImage?`, `phone?`, `isVerified` (`false`), `isActive` (`true`), `tokenVersion` (`0`), `fcmTokens` (`[]`), timestamps. Partial unique indexes: `{ authProvider, providerId }` (strings), `{ role: 1 }` where `role: "admin"` (single admin enforced).                                                                                                                        |
| `Student`      | `students`      | `user` (`ref: "User"`, unique, required), `rollNumber`, `course`, `semester`, `collegeName?`, `address?`, `deliveryAddresses` (`label, hostel, block, roomNumber, landmark, phone, isDefault`), `isActive` (`true`), timestamps.                                                                                                                                                                                                                                                                                                                                            |
| `Cafe`         | `cafes`         | `owner` (`ref: "User"`, unique), `code` (`CAFE-*` unique sparse), `name`, KYC/bank fields (`aadhaarNumber, panNumber, fssaiNumber, accountHolderName, accountNumber, ifscCode, gstNumber?`), `documents` (`panCard.front/back, identityProof.front/back, foodLicense, cancelledCheque`), `approvalStatus` (`pending\|approved\|rejected`), `isApproved` (`false`), `isOpen` (`false`), `isVisible` (`false`), `isActive` (`true`), `deliveryEnabled` (`true`), `pickupEnabled` (`true`), `deliveryFee` (`0`), `platformFee` (`0`), `rating` (`average, count`), timestamps. |
| `MenuItem`     | `menuitems`     | `cafe` (`ref: "Cafe"`), `name` (`max 150`), `description?` (`max 1000`), `price` (`min 0`), `category` (`"General"`), `image?` (`FileObject`), `isVeg` (`true`), `isAvailable` (`true`), `trackStock` (`false`), `stock` (`0`, `min 0`), timestamps. Unique case-insensitive index `{ cafe: 1, name: 1 }` (`collation: { locale: "en", strength: 2 }`).                                                                                                                                                                                                                     |
| `Cart`         | `carts`         | `student` (`ref: "Student"`), `cafe` (`ref: "Cafe"`), `items` (`menuItem, name, quantity>=1, price`), `orderMethod` (`delivery\|self_pickup`), `deliveryAddress?`, `orderNotes?`, `paymentMethod` (`online\|cash`), `totalAmount` (`0`), `status` (`active\|ordered\|cancelled`), timestamps, **`optimisticConcurrency: true`**. Partial unique index on `{ student: 1 }` where `status: "active"`.                                                                                                                                                                         |
| `Order`        | `orders`        | `orderNumber` (unique `pre("validate")`), `student` (`ref: "Student"`), `cafe` (`ref: "Cafe"`), `items[]`, `orderMethod`, `deliveryAddress?`, `notes?`, `subtotal`, `deliveryFee`, `platformFee`, `totalAmount`, `status` (`pending\|confirmed\|preparing\|ready\|delivered\|cancelled\|rejected`), `rejectionReason?`, `paymentMethod`, `paymentStatus` (`pending\|paid\|failed\|refunded`), `paymentId?`, `stockReleased` (`false`), `completedAt?`, timestamps. Partial index for unpaid online expiration.                                                              |
| `Payment`      | `payments`      | `paymentId` (unique `pay_*`), `order` (`ref: "Order"`), `student`, `cafe`, `amount`, `method` (`card\|upi\|wallet\|cashfree\|cash`), `status` (`pending\|success\|failed\|refunded`), `transactionId?`, `gatewayResponse?`, `commission`, `cafeEarning`, `settlementStatus` (`unsettled\|settled`), `refundStatus` (`none\|pending\|refunded\|failed`), `refundId?`, `refundRetryCount`, `refundNextRetryAt?`, `refundLastError?`, `refundRequestedAt?`, `refundedAt?`, `paidAt?`, timestamps. Partial unique indexes `uniq_order_pending_cashfree` & `uniq_order_cash`.    |
| `Session`      | `sessions`      | `sessionId` (unique UUID), `user`, `familyId`, `deviceName`, `deviceType`, `os`, `browser`, `userAgent`, `ipAddress`, `loginAt`, `lastActivityAt`, `lastRefreshAt?`, `expiresAt` (TTL index `expireAfterSeconds: 0`), `idleExpiresAt?`, `status` (`ACTIVE\|REVOKED\|EXPIRED`), `revokedAt?`, `revokedReason?`, timestamps.                                                                                                                                                                                                                                                  |
| `RefreshToken` | `refreshtokens` | `user`, `jti` (unique), `sessionId`, `familyId`, `tokenHash` (SHA-256 unique), `status` (`active\|rotated\|revoked`), `isRevoked`, `issuedAt`, `rotatedAt?`, `revokedAt?`, `revokedReason?`, `replacedByTokenHash?`, `expiresAt` (TTL index `expireAfterSeconds: 0`), `createdAt`.                                                                                                                                                                                                                                                                                          |
| `Review`       | `reviews`       | Schema defined (`student, cafe, order?, menuItem?, rating 1..5, comment?, isApproved: false`). **Routes/controllers/services NOT IMPLEMENTED.**                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Relationships**: `User (1) <-> (0..1) Student`, `User (1) <-> (0..1) Cafe`, `Cafe (1) -> (N) MenuItem`, `Student (1) -> (0..1 active) Cart`, `Student (1) -> (N) Order`, `Cafe (1) -> (N) Order`, `Order (1) -> (N) Payment`, `User (1) -> (N) Session`, `Session (1) -> (N) RefreshToken`.

---

## 10. Authentication and Authorization

- **Students & Cafe Owners**: Passwordless Google / Apple OAuth verified via Firebase Admin SDK (`src/service/auth.service.ts`). Cafe owner responses include `isApproved` and `approvalStatus`.
- **Admin**: Bootstrap via `POST /api/v1/auth/admin/register` guarded by `ADMIN_REGISTER_SECRET` (`crypto.timingSafeEqual` comparison, single-admin partial unique index) and email/password login (`bcryptjs` hash cost `BCRYPT_COST`).
- **Tokens**: Signed JWT access token (`jti`, `sid`, `tv`, `iss`, `aud`) + single-use SHA-256 hashed refresh token rotated inside `runWithOptionalTransaction`.
- **Replay Detection & Race Safety**: Reuse of rotated/revoked refresh tokens revokes the entire token family, closes the `Session`, increments `User.tokenVersion`, and broadcasts `user_revoked`. Concurrent benign refresh-vs-logout races return `401` without invalidating sibling devices.
- **Request Auth (`src/middlewares/authenticate.middleware.ts`)**: Checks `inMemoryMinTokenVersions`, `inMemoryRevokedSessions/Jtis`, batched Redis `MGET`, live `Session`, and `User` cache (using `"__DELETED__"` negative tombstone on deleted users). Role checks run via `authorize(...roles)`.

---

## 11. Business Logic and Workflows

1. **Cafe Onboarding & Open/Close Availability**:
   - Owner submits KYC + docs (`POST /api/v1/cafes`) -> Multer magic-byte check -> Cloudinary uploads -> `Cafe` created `pending` (assets rolled back on DB failure).
   - Admin approves/rejects (`/cafes/admin/:id/approve` | `/reject`) -> cache invalidated -> `cafe:approval_updated` emitted. Newly approved cafes remain `isOpen: false`.
   - Owner toggles availability (`PATCH /api/v1/cafes/owner/open-status`) -> verified `owner`, `isApproved`, `isActive` -> cache invalidated -> `cafe:open_status_changed` emitted.
2. **Menu & Stock Control**: `menu.service.ts` enforces owner cafe approval, magic-byte validated image uploads, atomic `$inc` stock adjustments (`$gte: -adjust`), menu cache invalidation, and `cafe:menu_updated` socket broadcast.
3. **Single-Cafe Concurrency-Safe Cart**: `cart.service.ts` uses `optimisticConcurrency: true` + up to 6 retry attempts on `VersionError`/`11000`, validates live prices & `findOrderableCafe({ requireOpen: true })` on adds/options, allows qty decrement/remove/clear even if cafe closed, and emits `cart:updated` / `cart:cleared`.
4. **Transaction-Safe Order Placement & Transitions**:
   - `placeOrderService` uses `runWithOptionalTransaction` + conditional stock deduction (`stock >= qty`), freezes order line prices from live `MenuItem` records, computes fees server-side (`deliveryFee` only for `delivery`), marks Cart `"ordered"`, and emits `order:created` **only after commit**.
   - Valid transitions: `pending -> confirmed` (`/accept`), `pending -> rejected` (`/reject`, releases stock + refunds paid online orders), `pending -> cancelled` (`/:orderId/cancel`), `confirmed -> preparing -> ready -> delivered` (`/status`, cash orders record paid `Payment` on delivery).
   - Closing a cafe blocks **new** orders (`409`) while never cancelling or blocking in-progress orders.

---

## 12. Redis and Caching

Implemented in `src/config/redis.config.ts` and `src/infrastructure/redis/`:

- **Dual Client Architecture**:
  - **Native TCP (`ioredis`)**: Powers `@socket.io/redis-adapter`, Pub/Sub invalidation (`cafemart:auth:cache:invalidate`), Lua rate limits, locks, idempotency, presence.
  - **Upstash REST (`@upstash/redis`)**: Stateless HTTP command fallback (does **not** power Socket.IO Pub/Sub).
- **Circuit Breaker (`redis.store.ts`)**: Opens for `5000 ms` after `5` consecutive failures (`CLOSED -> OPEN -> HALF_OPEN`), preventing command pileups.
- **Canonical Keys & TTLs (`redis.constants.ts`, `redis.keys.ts`)**:
  - Auth caches: `user:cache:{id}` (`120s`, `"__DELETED__"` `10s`), `session:meta:{sid}` (`300s`), `session:activity_throttle:{sid}` (`60s`), revocation markers (`900s` default or token TTL).
  - Read caches: `cache:cafe:public:{cafeId}` (`60s`), `cache:cafes:list:v{ver}:{hash}` (`30s`), `cache:cafe:menu:{cafeId}:*` (`30s`), `cache:admin:dashboard` (`15s`), identity maps (`300s`).
  - Coordination: `idem:{scope}:{owner}:{key}` (`60s` inflight / `300s` replay), `lock:*` (`SET NX EX` + Lua ownership release), `presence:sockets:{userId}` / `presence:user:{userId}` (`180s`).

---

## 13. Socket.IO Architecture

- **Init**: `initSocketServer()` (`src/socket/socket.server.ts`) attaches `@socket.io/redis-adapter` (`prefix: "cafemart:sio"`), enforces `allowEIO3: false`, `maxHttpBufferSize: 32 KB`, and ZSET per-user connection cap (`SOCKET_MAX_CONNECTIONS_PER_USER`, default `25`).
- **Auth & Revocation**: `socketAuthMiddleware` validates JWT + session from `handshake.auth.token` / `Authorization` header (rejects `?token=`), tracks multi-device Redis ZSET presence leases, schedules `exp` auto-disconnect timers, supports `auth:refresh`, and disconnects across all cluster workers on `cafemart:auth:cache:invalidate` Pub/Sub events (`auth:revoked`).
- **Rooms**: Identity rooms (`user:{id}`, `session:{sid}`, `student:{id}`, `cafe:{id}`, `cafe:private:{id}`, `admin`) auto-join on connect; `order:{orderId}` and `cafe:{cafeId}` subscriptions verify MongoDB ownership/visibility via `socketRoom.service.ts`.
- **REST-to-Socket Emission Map**: Emitted post-commit for `order:*` (22 events across order/payment/cart/cafe/auth lifecycle). Unpaid pending online orders withhold `cafe:private:{cafeId}` until Cashfree confirmation.

---

## 14. Payment Integration

- **Gateway**: Cashfree PG REST API (`https://sandbox.cashfree.com/pg` or `https://api.cashfree.com/pg`, `x-api-version: 2023-08-01`, `8000ms` timeout).
- **Session Creation (`POST /api/v1/payments/initiate`)**: Guarded by `Idempotency-Key` + Redis lock `lock:payment:initiate:{orderId}` + partial unique index `uniq_order_pending_cashfree`. Returns `paymentSessionId` for client checkout.
- **Authoritative Verification (`GET /status/:orderId`, `POST /webhook`)**: Webhook validates `x-webhook-timestamp` (`5 min` replay window) and `x-webhook-signature` (HMAC-SHA256 on raw body using `CASHFREE_SECRET_KEY`), acquires distributed lock `lock:payment:webhook:{cfOrderId}`, and queries Cashfree `GET /orders/{id}` (`PAID` / `EXPIRED` / `TERMINATED`) before transitioning `Payment` & `Order` and emitting `payment:*` / `emitOrderCreatedToCafe`.
- **Automatic & Scheduled Refunds**: Order cancel/reject on paid online orders triggers `refundPayment` (`rf_{paymentId}` idempotency). Retryable gateway failures schedule exponential backoff retries (`refundStatus: "pending"`, up to `5` retries) reconciled every 60s; exhausted retries move to dead-letter log/Redis key.

---

## 15. Background Jobs and Workers

Implemented in `src/job/index.ts` and `src/job/order.job.ts` (scheduled **only** on primary worker: `!cluster.worker || cluster.worker.id === 1` and `NODE_APP_INSTANCE` unset or `"0"`):

| Job                       | Schedule / Lock TTL                                 | Timeout / Retries                                      | Behavior                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expireUnpaidOrders`      | Every `5 min` (plus `5s` startup kick), lock `240s` | `60s` timeout, `2` retries + jitter + Redis DLQ (`7d`) | Scans batches of `50` (`max 500`/run, concurrency `5`) unpaid online pending orders `>20m` old, syncs Cashfree status first, cancels unpaid orders, releases stock, marks payment failed, invalidates menu cache, emits `order:cancelled`. |
| `reconcilePendingRefunds` | Every `60s` (`15s` startup delay), lock `120s`      | `50s` timeout                                          | Processes failed Cashfree refunds whose `refundNextRetryAt <= now`, verifies existing refund or re-submits with stable `refundId`.                                                                                                         |

---

## 16. Security Architecture

- **HTTP & Network**: Helmet CSP + `X-Frame-Options: DENY`, HSTS in production, strict CORS allowlist (throws `403`, never `*` with credentials), configurable `TRUST_PROXY`.
- **Rate Limiting**: Redis sliding-window Lua limiters (`rateLimiter.middleware.ts`) with progressive exponential cooldowns on Admin login (`adminLoginLimiter` / `adminRegisterLimiter`, fail-closed) and user-scoped fail-closed limiters on cart/order/payment/cafe/admin routes.
- **Uploads**: `multer.memoryStorage()` (`5 MB`/file, `max 16` files) + magic-byte JPEG/PNG/WEBP header inspection matching declared MIME (`validateUploadedImagesMiddleware`). Private KYC docs uploaded with `type: "authenticated"` and fetched via bounded 60–3600s Cloudinary signed URLs.
- **Logging Sanitization**: Winston redacts tokens, passwords, secrets, card/PIN keys, inline `Bearer`/JWT patterns, and DB URI credentials (`sanitizeLogData`).

---

## 17. Error Handling and Logging

- **App Errors (`src/utils/errors/app.error.ts`)**: `BadRequestError` (`400`), `UnauthorizedError` (`401`), `ForbiddenError` (`403`), `NotFoundError` (`404`), `ConflictError` (`409`), `RateLimitError` (`429`), `ExternalServiceError` (`502`/`503`), `InternalServerError` (`500`).
- **Centralized Handler (`src/middlewares/error.middleware.ts`)**: Normalizes Mongoose `ValidationError`/`CastError`/`VersionError`/`11000`, JWT errors, malformed JSON `SyntaxError`, `MulterError`, `ZodError`, and hides internal error details/stacks in production.
- **Logging (`src/config/logger.config.ts`)**: Shared `logger` + dedicated `securityAuditLogger` (`LOG_TO_FILE=true` enables daily rotation via `winston-daily-rotate-file`), AsyncLocalStorage per-request correlation (`requestId`, `userId`, `sessionId`, `route`, `ip`), and `flushLoggers()` during graceful shutdown.

---

## 18. Testing

Automated Node test runner (`node --test --test-concurrency=1 tests/*.test.mjs`) spins up isolated temporary `mongod` and `redis-server` processes (`tests/helpers/test-env.mjs`):

```bash
cd BACKEND
npm run typecheck
npm run build
npm test
```

Test files in `BACKEND/tests/`:

- `tests/swagger.test.mjs`: Validates `/docs` (`301 -> /docs/`), `/docs/` (`200`, no loop), Swagger assets, `/docs-json`, exact 2 `servers`, 1:1 coverage across all 62 `/api/v1` operations, zero broken `$ref`s, and `ENABLE_SWAGGER=false` / `SWAGGER_ACCESS_KEY` guards.
- `tests/cafe-availability.test.mjs`: Validates owner-only `PATCH /api/v1/cafes/owner/open-status`, removed admin route (`404`), approval/active checks, `cafe:open_status_changed`, closed order blocking (`409`), and in-flight order completion.
- `tests/socket-realtime.test.mjs`: Validates handshake JWT/query rejection, `order:subscribe` / `cafe:subscribe` authorization, `auth:refresh`, multi-device Redis presence leases, `cafe:menu_updated` / `cart:updated` emitters, and cross-worker `@socket.io/redis-adapter` delivery.
- `tests/auth-logger-unit.test.mjs`: Validates `__DELETED__` Redis user cache tombstone survival after `revokeSession`, `sanitizeLogData`, and `DailyRotateFile` `flushLoggers()`.

---

## 19. Performance and Scalability

- Cache-aside Redis layer for high-read cafe listings, cafe details, menus, orderable metadata, user/session auth checks, and admin dashboard metrics.
- Stampede coalescing for concurrent DB user lookups (`inFlightUserFetches`, `inFlightLiveAuthChecks` in `authenticate.middleware.ts`).
- Multi-core scaling via `src/cluster.ts` or PM2 cluster + `@socket.io/redis-adapter` + Redis primary-worker distributed job locks.
- **Concurrent capacity**: No formal load-test benchmark (e.g., k6/Artillery) exists in this repository; concurrent capacity limits are **NOT VERIFIED**.

---

## 20. Deployment

- **Render / Production Start**:
  - Build command: `npm ci && npm run build`
  - Start command: `npm start` (`node dist/server.js`) or `npm run start:cluster` (`node dist/cluster.js`)
  - Set `NODE_ENV=production`, `TRUST_PROXY=1` (behind Render proxy), strong secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_REGISTER_SECRET`), production `MONGODB_URI`, native TCP `REDIS_URL` (`rediss://...`), and production `CORS_ORIGIN` / `CLIENT_URL` / `SERVER_URL` / `API_BASE_URL`.
- **Sticky Sessions**: If `SOCKET_TRANSPORTS` includes `polling` across multiple horizontally scaled instances, enable sticky sessions (session affinity) at the load balancer, or configure `SOCKET_TRANSPORTS=websocket` if WebSocket-only is desired.
- **Graceful Shutdown**: Stops cron jobs, drains HTTP & Socket.IO connections (`10s` hard timeout), closes Redis and Mongoose cleanly, and flushes Winston loggers before `process.exit(0)`.

---

## 21. Health Checks and Monitoring

- `GET /live`: Lightweight process check (`{ success: true, live: true }`).
- `GET /ready`: Kubernetes/Render readiness probe returning `503` if MongoDB is disconnected, `serverDraining === true`, or Redis is unavailable under `REDIS_REVOCATION_FAIL_CLOSED=true`.
- `GET /health`: Full diagnostics JSON with MongoDB status, Redis circuit breaker/latency/metrics (`getRedisHealthDetails()`), and Socket.IO status (`getSocketHealthStatus()`, including `workerId`, `connectedSockets`, `redisAdapterAttached`, `adapterPubReady`, `adapterSubReady`).

---

## 22. Troubleshooting

| Issue                                                   | Root Cause                                                                     | Resolution                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Server exits immediately on startup                     | Missing required env var in `src/config/index.ts` or unreachable MongoDB       | Verify `.env` against Section 6; ensure `MONGODB_URI` & non-local production `rediss://` rules pass      |
| Multi-document transaction fallback log (`MONGO_NO_TX`) | Standalone local `mongod` without replica set                                  | Run local `mongod --replSet rs0` + `rs.initiate()` for ACID transactions, or ignore fallback in dev      |
| Protected endpoints return `503`                        | Redis unreachable with `REDIS_REVOCATION_FAIL_CLOSED=true`                     | Restore Redis (`REDIS_URL` / Upstash REST) or set `REDIS_REVOCATION_FAIL_CLOSED=false` only in local dev |
| `/docs` redirects infinitely or returns `404`           | Old `ENABLE_SWAGGER=false` in `.env` or stale `dist/`                          | Set `ENABLE_SWAGGER=true` (or omit), run `npm run build`, verify `GET /docs/` returns `200`              |
| Socket events don't cross workers                       | Missing native TCP `REDIS_URL` (`Upstash REST` cannot power Socket.IO Pub/Sub) | Configure native TCP `REDIS_URL` (`rediss://...`)                                                        |
| `EADDRINUSE` on port `8000`                             | Another local backend process running on port `8000`                           | Stop conflicting process or change `PORT` in `.env`                                                      |

---

## 23. Important Backend File References

- `BACKEND/src/server.ts`, `BACKEND/src/cluster.ts`, `BACKEND/src/app/app.ts`
- `BACKEND/src/config/index.ts`, `db.config.ts`, `redis.config.ts`, `logger.config.ts`, `swagger.config.ts`, `cloudinary.config.ts`, `cashfree.config.ts`
- `BACKEND/src/routers/v1/index.router.ts`, `auth.router.ts`, `cafe.router.ts`, `menu.router.ts`, `cart.router.ts`, `order.router.ts`, `payment.router.ts`, `admin.router.ts`
- `BACKEND/src/middlewares/authenticate.middleware.ts`, `rateLimiter.middleware.ts`, `upload.middleware.ts`, `error.middleware.ts`
- `BACKEND/src/infrastructure/redis/redis.store.ts`, `redis.lock.ts`, `redis.idempotency.ts`, `redis.keys.ts`, `redis.constants.ts`
- `BACKEND/src/socket/socket.server.ts`, `socket.events.ts`, `socket.types.ts`, `middleware/socketAuth.middleware.ts`, `services/socketEmitter.service.ts`, `services/socketRoom.service.ts`, `services/socketPresence.service.ts`, `services/socketRevocation.service.ts`
- `BACKEND/src/job/index.ts`, `BACKEND/src/job/order.job.ts`

---

## 24. Known Limitations and Pending Work

- **Reviews API (`NOT IMPLEMENTED`)**: `src/models/review.model.ts` exists, but no review routes, controllers, or services exist yet.
- **Dedicated Profile / Student Self-Service REST APIs (`NOT IMPLEMENTED`)**: No student profile edit or standalone `/users` endpoints exist beyond social auth, cart/order usage, and admin read/moderation routes.
- **`cafe:profile_updated` & `payment:processing` Socket Emitters**: Defined in `src/socket/socket.events.ts` and `socketEmitter.service.ts`, currently unreferenced by runtime services.
- **`src/validators/index.ts`**: Generic `validateRequestBody` / `validateQueryParams` Zod middlewares exist, while current REST controllers perform custom inline field validation instead of mounting them on routes.
- **Load Testing (`NOT VERIFIED`)**: High-concurrency throughput/latency benchmarks have not yet been executed against production-sized infrastructure.
