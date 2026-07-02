# meet-to-manage-middleware

A multi-tenant auth proxy/gateway that sits in front of one or more existing
"main service" backends (e.g. `online-class-management-platform`) without
requiring any changes to those backends.

Clients talk to this middleware exactly as they would talk to the main
service directly. The middleware:

- Intercepts `POST /api/auth/register` and `POST /api/auth/login`, resolving
  which tenant (and therefore which main-service deployment) a user belongs
  to. (The `/api` prefix matches this deployment's frontends; see
  `IMPLEMENTATION_PLAN.md` "Route Priority".)
- Auto-creates a tenant record on first registration — no separate admin
  step is needed to onboard a new tenant.
- Transparently proxies every other request to that tenant's main service,
  swapping its own JWT for the tenant's real upstream access token on the
  way through.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full design
rationale, security considerations, and phase-by-phase build notes. This
README is the practical "how do I run this / how do I plug in a main
service" reference.

## How it works, at a glance

```
Client
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                  Middleware (this app)                    │
│                                                          │
│  POST /api/auth/register  ──► resolve/create tenant,      │
│                            forward cleaned body to main   │
│                                                          │
│  POST /api/auth/login     ──► resolve tenant, forward creds,  │
│                            issue our own JWT (no upstream │
│                            secret inside it — see below)  │
│                                                          │
│  everything else      ──► verify our JWT, look up the     │
│                            tenant's session in Redis,     │
│                            swap in the real upstream       │
│                            token, proxy the request        │
└──────────────────────────────────────────────────────────┘
          │                         │
          ▼                         ▼
  ┌───────────────┐         ┌───────────────┐
  │  Tenant A      │         │  Tenant B      │
  │  main service  │         │  main service  │
  │  (unchanged)   │         │  (unchanged)   │
  └───────────────┘         └───────────────┘
```

The middleware's own JWT never contains the tenant's real upstream token —
that's held server-side in Redis, keyed by the JWT's `jti`. A leaked
middleware JWT is therefore just a pointer, not a leaked upstream
credential. See [`jwt-payload.interface.ts`](src/modules/auth/jwt-payload.interface.ts).

## Project layout

```
src/
├── main.ts                    # bootstrap: helmet, CORS, body limits, global pipe/filter
├── app.module.ts               # wires everything together
├── config/configuration.ts     # typed env config; fails fast on placeholder secrets in prod
├── database/
│   ├── entities/                # TenantMaster, UserTenantMapping
│   ├── migrations/               # hand-written initial schema
│   └── data-source.ts            # TypeORM CLI data source (for migration:* scripts)
├── redis/                       # session:{jti} / refresh:{refreshJti} storage
├── modules/
│   ├── auth/                    # register / login / refresh / logout / upstream-session
│   ├── proxy/                   # transparent pass-through middleware
│   ├── tenant/                  # /middleware/admin/* tenant + mapping management
│   └── health/                  # /middleware/health
└── common/
    ├── guards/                   # JwtAuthGuard, AdminGuard (bcrypt Basic auth)
    ├── interceptors/              # request logging (no bodies/secrets), upstream error sanitizing
    ├── filters/                   # global exception filter (no stack traces to clients)
    └── utils/                     # SSRF guard, dot-path extraction, duration parsing, log redaction
```

## Prerequisites

- Node.js 20+
- A reachable Postgres instance (this project does **not** run Postgres in
  Docker — bring your own, local or remote, and point `DB_HOST`/`DB_PORT` at
  it)
- Redis (the provided `docker-compose.yml` runs this for you)

## Running it locally

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create your `.env`** from the template and fill in real values:

   ```bash
   cp .env.example .env
   ```

   At minimum, set:
   - `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` — your
     Postgres instance. The middleware's database is completely separate
     from any main service's own database; it only stores tenant routing
     info and a thin `username → tenant` pointer, never passwords or
     profile data.
   - `JWT_SECRET` / `JWT_REFRESH_SECRET` — generate real values, e.g.
     `openssl rand -base64 48`. Never reuse the placeholders from
     `.env.example` — the app **refuses to start in production** if it
     detects placeholder values still in place (see `configuration.ts`).
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` — bootstrap credentials for the
     tenant-admin endpoints. Generate a hash with:
     ```bash
     node -e "require('bcrypt').hash('yourpassword', 12).then(console.log)"
     ```
   - The `REGISTER_PATH` / `LOGIN_PATH` / field-mapping variables — see
     [Connecting a main service](#connecting-a-main-service) below.

3. **Create the database** (if it doesn't already exist) and run the
   migration:

   ```bash
   # createdb mtm_middleware   (or however you provision a DB on your Postgres)
   npm run migration:run
   ```

4. **Start Redis** (skip if you already have one reachable at
   `REDIS_HOST`/`REDIS_PORT`):

   ```bash
   docker compose up -d redis
   ```

5. **Run the app**

   ```bash
   npm run start:dev   # watch mode
   # or
   npm run build && npm run start:prod
   ```

6. **Check it's alive**

   ```bash
   curl http://localhost:3000/middleware/health
   # {"status":"ok"}
   ```

### Running everything via Docker Compose

`docker-compose.yml` runs Redis and the app (build from the local
`Dockerfile`). Postgres is intentionally excluded — point `DB_HOST` in
`.env` at wherever your Postgres actually lives. If that Postgres runs on
the same physical machine as the compose stack (rather than a separate
reachable host), use `DB_HOST=host.docker.internal` instead of `localhost`
so the containerized app can reach it.

```bash
docker compose up -d
```

## Connecting a main service

The middleware adapts to a main service entirely through environment
variables — no code changes are needed to point it at a new backend.
**Before wiring one up, check the real registration/login contract of that
main service** (required fields, response envelope shape, whether it has
its own tenant/institute concept). Don't assume; verify. The values below
are examples that matched a real Express-based main service encountered
during development (`online-class-management-platform`), not universal
defaults.

| Variable | Meaning |
|---|---|
| `REGISTER_PATH` | Path on the main service that register requests are forwarded to, e.g. `/api/auth/register`. |
| `LOGIN_PATH` | Path on the main service that login requests are forwarded to, e.g. `/api/auth/login`. |
| `UPSTREAM_REFRESH_PATH` | Path on the main service used to mint a new upstream access token, e.g. `/api/auth/refresh-token`. Leave empty if the main service has no refresh endpoint — refresh will then fail with a "please log in again" error once the upstream token expires. |
| `USERNAME_FIELD` | Which field in the register/login body identifies the user (usually `email`). |
| `TENANT_CODE_FIELD` | Which field the **client** sends to the middleware to identify their tenant, e.g. `tenantCode`. |
| `TENANT_NAME_FIELD` / `API_URL_FIELD` | Fields the client sends only when registering the *first* user of a brand-new tenant (see below). These are middleware-only concerns and are always stripped before forwarding. |
| `FORWARD_TENANT_CODE_AS` | If the main service itself has its own tenant/institute concept and requires a field on register/login, set this to that field name (e.g. `instituteCode`) — the middleware will rename-and-forward the tenant code instead of stripping it. Leave empty if the main service has no tenant concept of its own. |
| `UPSTREAM_TOKEN_PATH` | Dot-path into the main service's login response where the access token lives, e.g. `data.accessToken` if the response is `{ success, message, data: { accessToken } }`, or just `accessToken` if it's a flat field. |
| `UPSTREAM_REFRESH_TOKEN_PATH` | Same idea, for the upstream refresh token. |
| `ALLOW_PRIVATE_API_URLS` | Dev-only escape hatch to allow registering a tenant whose `apiUrl` points at localhost/private IPs (e.g. a locally-running main service during development). **Must be `false` in any real deployment** — the app refuses to boot in production if this is `true`. |

Everything else in the request body that isn't one of the fields above
passes through to the main service completely untouched — if the target
main service's registration form needs `firstName`, `phone`, or anything
else this middleware knows nothing about, the client can send it and it
will be forwarded as-is.

### Onboarding the first tenant

The first user of a new tenant registers with both their own credentials
*and* enough info for the middleware to create a tenant record:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@acme.com",
    "password": "secretpass123",
    "tenantCode": "acme",
    "tenantName": "Acme Corp",
    "apiUrl": "https://api.acme.com"
  }'
```

- `apiUrl` must be `https://` and must not resolve to a loopback, private,
  or link-local address (this is enforced, not optional — see
  [`ssrf-guard.ts`](src/common/utils/ssrf-guard.ts)). It's persisted and
  reused for every future login against this tenant, so it's validated
  once, strictly, at creation time.
- Every subsequent user from the same tenant registers with only
  `tenantCode` (no `tenantName`/`apiUrl` needed — they're ignored if sent,
  since the tenant record already exists).
- `tenantCode`, `tenantName`, and `apiUrl` are stripped from the body
  before forwarding to the main service (unless `FORWARD_TENANT_CODE_AS` is
  set, in which case the tenant code is renamed and forwarded instead of
  stripped — see the table above).

### Managing tenants afterward

Tenant admin endpoints live under `/middleware/admin/*` (never forwarded to
a main service — see the route priority note in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)) and are protected by
HTTP Basic auth against `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`:

```bash
curl -u admin@internal.com:yourpassword http://localhost:3000/middleware/admin/tenants
curl -u admin@internal.com:yourpassword -X PATCH http://localhost:3000/middleware/admin/tenants/<id> \
  -H "Content-Type: application/json" -d '{"apiUrl": "https://new-api.acme.com"}'
curl -u admin@internal.com:yourpassword -X DELETE http://localhost:3000/middleware/admin/tenants/<id>   # deactivate
curl -u admin@internal.com:yourpassword http://localhost:3000/middleware/admin/mappings
curl -u admin@internal.com:yourpassword -X DELETE http://localhost:3000/middleware/admin/mappings/<id>  # disable one user
```

Deactivating a tenant or a user mapping doesn't instantly kill an
already-issued session — it takes effect once that session's short-lived
JWT (`JWT_EXPIRES_IN`, default 15m) naturally expires.

## Day-to-day request flow through the middleware

Once a tenant exists and a user is registered, everyday traffic looks like
this:

1. **Login** — `POST /api/auth/login` with `{ email, password }`. The
   middleware resolves the tenant from its own `user_tenant_mapping` table,
   forwards the credentials to that tenant's main service, and — on
   success — mints its own short-lived JWT + refresh token. The main
   service's real access token is stored server-side in Redis
   (`session:{jti}`), never returned to the client.

2. **Everyday API calls** — call the middleware exactly as you would call
   the main service directly (same paths, same methods, same bodies),
   using `Authorization: Bearer <middleware access token>`. The middleware
   verifies the JWT, looks up the Redis session, swaps in the real upstream
   token, and forwards the request byte-for-byte. If the tenant's main
   service returns an error or is unreachable, the client gets a generic
   `502 Upstream unavailable` rather than internal connection details.

3. **Refreshing** — `POST /middleware/auth/refresh` with
   `{ refreshToken }` once the access token expires. This calls the main
   service's own `UPSTREAM_REFRESH_PATH` to mint a fresh upstream token
   (not just extend the old Redis entry), then issues a new middleware JWT
   + rotated refresh token.

4. **Logging out** — `POST /middleware/auth/logout` (authenticated),
   optionally with `{ refreshToken }` in the body to also revoke the
   refresh session. This deletes both `session:{jti}` and
   `refresh:{refreshJti}` from Redis, so a stolen refresh token stops
   working immediately rather than staying valid for its full 7-day
   lifetime.

5. **Real-time / WebSocket traffic (Socket.IO etc.)** — explicitly **out of
   scope** for the transparent proxy (a generic HTTP/WS proxy can't rewrite
   a Socket.IO handshake's `auth.token` payload). Instead, call:

   ```bash
   curl http://localhost:3000/middleware/auth/upstream-session \
     -H "Authorization: Bearer <middleware access token>"
   # { "apiUrl": "https://api.acme.com", "upstreamToken": "<real upstream token>" }
   ```

   and connect directly to the main service with that token:
   `io(apiUrl, { auth: { token: upstreamToken } })`. This hands the client
   the same credential it would have gotten by logging into the main
   service directly, so it doesn't weaken anything — it's rate-limited and
   should be audit-logged the same way as login.

## Migrations

```bash
npm run migration:generate   # generate a new migration from entity changes
npm run migration:run        # apply pending migrations
npm run migration:revert     # roll back the last migration
```

## Security notes

See the "Security Considerations" table in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full list of
threats this design accounts for (SSRF on `apiUrl`, JWT/session design,
rate limiting, admin auth, log redaction, etc.) and why each mitigation
exists.
