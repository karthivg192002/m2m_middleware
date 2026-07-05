# Meet-to-Manage Middleware — Implementation Plan

## Core Constraints

> 1. **No changes to any main service.** The middleware is the only thing that changes.
> 2. **Users are registered in the main service only.** The middleware never duplicates user data — it stores only `username/email` as a foreign key to the tenant.
> 3. **Tenant is created automatically at registration time.** No separate admin login or manual tenant creation step.

---

## What the Middleware Stores (and what it does NOT)

| Data                         | Stored in Middleware? | Stored in Main Service? |
|------------------------------|-----------------------|--------------------------|
| Tenant name, code, api_url   | Yes — `tenant_master` | No                       |
| username / email (key only)  | Yes — `user_tenant_mapping` | Yes (full profile) |
| Password, profile, role      | **No**                | Yes                       |
| Business data                | **No**                | Yes                       |

The middleware's `user_tenant_mapping` is intentionally a thin pointer — it says "this email belongs to this tenant" and nothing more.

---

## Architecture

```
Client
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                  Middleware (This App)                    │
│                                                          │
│  POST /api/auth/register  ──► Intercept:                 │
│    • if tenant doesn't exist → create it (from request)  │
│    • insert (username, tenant_id) into user_tenant_mapping│
│    • strip tenantCode/apiUrl from body                   │
│    • forward cleaned body to main service                │
│    • if main service auto-logs-in and returns a token,   │
│      swap it for a middleware session (same as login)    │
│    • otherwise return main service response unchanged    │
│                                                          │
│  POST /api/auth/login     ──► Intercept:                 │
│    • look up username in user_tenant_mapping → api_url   │
│    • forward credentials to {api_url}/auth/login         │
│    • embed api_url + upstream token into middleware JWT  │
│    • swap the token in-place inside the upstream response │
│      envelope (preserves user/etc. — see below)          │
│    • return the reshaped response to client               │
│                                                          │
│  ALL other routes     ──► Transparent Pass-Through:      │
│    • extract api_url from middleware JWT                 │
│    • swap Authorization header (MW JWT → upstream token) │
│    • forward request byte-for-byte                       │
│    • stream response back unchanged                      │
└──────────────────────────────────────────────────────────┘
          │                         │
          ▼                         ▼
  ┌───────────────┐         ┌───────────────┐
  │  Tenant A     │         │  Tenant B     │
  │  Main Service │         │  Main Service │
  │  (unchanged)  │         │  (unchanged)  │
  └───────────────┘         └───────────────┘
```

---

## Database Schema (Middleware DB Only)

### `tenant_master`

```sql
CREATE TABLE tenant_master (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_name  VARCHAR(255) NOT NULL,
  tenant_code  VARCHAR(100) NOT NULL UNIQUE,  -- slug: "acme", "globex"
  api_url      TEXT         NOT NULL,          -- base URL of the tenant's main service
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### `user_tenant_mapping`

Only the minimum needed to resolve which `api_url` a user belongs to.

```sql
CREATE TABLE user_tenant_mapping (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  username     VARCHAR(255) NOT NULL UNIQUE,  -- one user belongs to exactly one tenant
  tenant_id    UUID         NOT NULL REFERENCES tenant_master(id) ON DELETE RESTRICT,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

That is the complete schema. No passwords. No profiles. No roles. No external IDs.

---

## Registration Flow — Tenant Auto-Creation

The first user to register for a tenant supplies the `apiUrl` in their request. All subsequent users from the same tenant supply only `tenantCode` — the tenant record already exists.

```
POST /api/auth/register
{
  "email":      "john@acme.com",
  "password":   "secret",
  "tenantCode": "acme",
  "tenantName": "Acme Corp",          ← only required when tenant doesn't exist yet
  "apiUrl":     "https://api.acme.com" ← only required when tenant doesn't exist yet
}
```

**Middleware steps:**

```
1. SELECT * FROM tenant_master WHERE tenant_code = 'acme'

   ┌── Tenant does NOT exist:
   │     Validate apiUrl (https://, reject private/loopback/link-local hosts)
   │     INSERT INTO tenant_master (tenant_name, tenant_code, api_url)
   │     VALUES ('Acme Corp', 'acme', 'https://api.acme.com')
   │
   └── Tenant already exists:
         Use existing record (tenantName + apiUrl from request are ignored)

2. INSERT INTO user_tenant_mapping (username='john@acme.com', tenant_id)
   ON CONFLICT (username) DO NOTHING  ← idempotent; username is globally unique

3. Strip middleware-only fields (tenantName, apiUrl) from request body.
   The tenant-code field is NOT stripped — it is RENAMED and forwarded, because
   some main services (e.g. one that is itself institute/org-scoped) require their
   own tenant identifier on register. Controlled by:
     TENANT_CODE_FIELD=tenantCode        ← field name the client sends to the middleware
     FORWARD_TENANT_CODE_AS=instituteCode ← field name forwarded upstream (empty = strip, matches old behavior)
   One deployment = one tenant, so this value is constant per deployment — it isn't
   a new tenant concept, just satisfying that main service's own required field.

4. POST mapped body → {api_url}{REGISTER_PATH}
   Body forwarded: { "email": "john@acme.com", "password": "secret", "instituteCode": "acme" }

5. If the main service's register response contains a token at UPSTREAM_TOKEN_PATH
   (some auto-log-in the new user), swap it for a middleware session — identical
   to step 3-6 of the Login Flow below — so the client never receives a raw
   upstream token it can't use against the proxy. Otherwise return the main
   service response to client as-is (status + body unchanged).
```

**What the main service receives (example matching a main service that itself requires a tenant/institute code):**
```
POST /api/auth/register
{ "email": "john@acme.com", "password": "secret", "instituteCode": "acme" }
```

> If `FORWARD_TENANT_CODE_AS` is left empty, behavior reverts to the original design (field fully stripped) for main services that have no tenant concept of their own. Set per-deployment based on what the target main service actually requires — verify against its real registration validation before assuming either way; a main service that requires a non-empty tenant/institute code will reject requests with it stripped.

---

## Login Flow — apiUrl Resolution

```
POST /api/auth/login
{
  "email":    "john@acme.com",
  "password": "secret"
}
```

**Middleware steps:**

```
1. SELECT utm.username, tm.api_url, tm.tenant_id
     FROM user_tenant_mapping utm
     JOIN tenant_master tm ON tm.id = utm.tenant_id
    WHERE utm.username = 'john@acme.com'
      AND utm.is_active = true
      AND tm.is_active  = true

   ← if no row found → 401 Unauthorized (user not registered via middleware)

2. POST { email, password, [instituteCode if FORWARD_TENANT_CODE_AS is set] } → {api_url}{LOGIN_PATH}
   (credentials forwarded verbatim — main service verifies them)
   Optionally also set header X-Institute-ID if the main service supports resolving
   tenant via header instead of/in addition to body field (check target main service).

3. Extract upstream token from main service response using UPSTREAM_TOKEN_PATH
   (a dot-path, e.g. "data.accessToken" — main service responses are often wrapped
   in an envelope like { success, message, data: { accessToken, ... } } rather than
   returning the token as a flat top-level field)

4. Sign middleware JWT (no upstream secret inside — see below):
   {
     sub:           utm.id,
     username:      'john@acme.com',
     tenantId:      tm.id,
     apiUrl:        'https://api.acme.com',  ← resolved once, carried for full session
     jti:           uuid()
   }

5. Cache in Redis, keyed by jti — this is the ONLY place the upstream token lives server-side:
   SET session:{jti} { apiUrl, upstreamToken } EX 900
   SET refresh:{refreshJti} { userId, tenantId } EX 604800   ← enables refresh-token revocation on logout

6. Return to client — the main service's own response envelope, unchanged
   except the token field(s) (at UPSTREAM_TOKEN_PATH / UPSTREAM_REFRESH_TOKEN_PATH)
   are overwritten with the middleware's own tokens. Anything else the main
   service returned alongside the token (e.g. a `user` object) passes through
   untouched, so clients written against the main service's own response shape
   don't need to change how they parse it:
   {
     "success": true,
     "message": "Login successful",
     "data": {
       "user": { ... },                        // passed through unchanged
       "accessToken":  "<middleware_jwt>",      // carries jti, no secret payload
       "refreshToken": "<refresh_jwt>"          // carries refreshJti only
     }
   }
```

A leaked middleware JWT (via logs, XSS, error reports, browser devtools) is now just a pointer — it's useless without the matching Redis entry, and revoking a session is a single Redis DEL rather than relying on token expiry.

---

## Refresh Flow — Renewing the Upstream Token

The middleware's own JWT (`JWT_EXPIRES_IN`, e.g. 15m) is deliberately shorter-lived than whatever the main service's own access token TTL is — the two are independent. Refreshing must mint a **new upstream token**, not just extend the Redis TTL on the old one, since the old upstream token has its own separate (and possibly already-expired) lifetime.

```
POST /auth/refresh  (middleware's own endpoint — client-facing)
{ "refreshToken": "<middleware_refresh_jwt>" }

Middleware steps:
1. Verify refresh JWT → extract refreshJti
2. GET refresh:{refreshJti} from Redis → { userId, tenantId }
   ← missing key (already revoked/logged out) → 401
3. POST {apiUrl}{UPSTREAM_REFRESH_PATH} with the stored upstream refresh token
   (if the main service exposes one — e.g. "/api/auth/refresh-token" with
   { refreshToken } in the body; verify the target main service's actual
   refresh contract before wiring this up, it varies per backend)
4. Extract new upstream accessToken (+ refreshToken if rotated) via UPSTREAM_TOKEN_PATH
5. Sign a new middleware JWT with a new jti; SET session:{new jti} { apiUrl, upstreamToken } EX 900
6. Return new { accessToken, refreshToken } to client
```

If the target main service has no refresh endpoint at all, the fallback is forcing full re-login once the upstream token expires — document which case applies per deployment rather than assuming.

---

## Pass-Through Flow — All Other Requests

```
Client:   GET /api/meetings
          Authorization: Bearer <middleware_jwt>

Middleware:
  1. Verify middleware JWT signature/expiry → extract { jti, apiUrl, tenantId }
  2. GET session:{jti} from Redis → { apiUrl, upstreamToken }
     ← missing key (revoked/expired/logged out) → 401, even if the JWT itself still verifies
  3. Replace header: Authorization: Bearer <upstreamToken>
  4. Forward → {apiUrl}/api/meetings  (same method, headers, body, query params)
  5. Stream response back unchanged

Main service receives:
  GET /api/meetings
  Authorization: Bearer <upstreamToken>
  ← identical to a direct call
```

---

## Route Priority

```
/middleware/admin/*         → Middleware admin module  (never forwarded)
POST /api/auth/register     → Auth module — intercept  (upstream target is env-configurable via REGISTER_PATH)
POST /api/auth/login        → Auth module — intercept  (upstream target is env-configurable via LOGIN_PATH)
POST /api/auth/refresh-token → Auth module — compat alias for POST /middleware/auth/refresh
POST /api/auth/google       → Auth module — intercept  (upstream target is env-configurable via GOOGLE_PATH)
/**                         → Proxy middleware          (transparent pass-through)
```

The `/api` prefix on the client-facing auth paths matches this deployment's
frontends (they already call their main service at `/api/auth/*`) — it is not
inherent to the middleware's design, just chosen to match. A different
deployment's frontends could use a different prefix; the client-facing paths
are set in `auth.controller.ts` route decorators, independent of
`REGISTER_PATH`/`LOGIN_PATH` (which only control the upstream forwarding target).

Admin paths are prefixed with `/middleware/` so they can never collide with any main service route.

---

## Project Structure

```
meet-to-manage-middleware/
├── src/
│   ├── app.module.ts
│   ├── main.ts
│   │
│   ├── config/
│   │   └── configuration.ts               # typed, validated env config
│   │
│   ├── database/
│   │   ├── entities/
│   │   │   ├── tenant-master.entity.ts
│   │   │   └── user-tenant-mapping.entity.ts
│   │   └── migrations/
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts         # mounts at REGISTER_PATH + LOGIN_PATH
│   │   │   ├── auth.service.ts
│   │   │   ├── strategies/jwt.strategy.ts
│   │   │   └── dto/
│   │   │       ├── register.dto.ts        # email, password, tenantCode, tenantName?, apiUrl?
│   │   │       └── login.dto.ts           # email, password
│   │   │
│   │   ├── tenant/
│   │   │   ├── tenant.module.ts
│   │   │   ├── tenant.controller.ts       # /middleware/admin/tenants  (view + manage only)
│   │   │   ├── tenant.service.ts
│   │   │   └── dto/
│   │   │       └── update-tenant.dto.ts   # only update allowed; creation is via register
│   │   │
│   │   └── proxy/
│   │       ├── proxy.module.ts
│   │       └── proxy.middleware.ts        # transparent pass-through
│   │
│   ├── common/
│   │   ├── decorators/current-user.decorator.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   └── admin.guard.ts
│   │   └── interceptors/upstream-error.interceptor.ts
│   │
│   └── redis/
│       ├── redis.module.ts
│       └── redis.service.ts
│
├── .env.example
├── docker-compose.yml
└── package.json
```

---

## API Endpoints

### Middleware Admin — Tenant Management

| Method | Path                           | Description                         |
|--------|--------------------------------|-------------------------------------|
| GET    | /middleware/admin/tenants      | List all tenants                    |
| GET    | /middleware/admin/tenants/:id  | Get tenant details                  |
| PATCH  | /middleware/admin/tenants/:id  | Update tenant name / apiUrl         |
| DELETE | /middleware/admin/tenants/:id  | Deactivate tenant                   |
| GET    | /middleware/admin/mappings     | List user-tenant mappings           |
| DELETE | /middleware/admin/mappings/:id | Deactivate a mapping (disable user) |

> No `POST /tenants` endpoint — tenants are created automatically at first registration.

### Intercepted Auth

| Method | Path                    | Description                                                  |
|--------|-------------------------|----------------------------------------------------------------|
| POST   | /api/auth/register      | Create tenant (if new) + mapping, forward to main, swap token if auto-issued |
| POST   | /api/auth/login         | Resolve apiUrl, forward creds, return reshaped response with MW tokens |
| POST   | /api/auth/refresh-token | Compat alias for `/middleware/auth/refresh`, response wrapped in `{data:{...}}` |
| POST   | /api/auth/google        | Verify Google ID token, resolve tenant, upsert mapping, forward to main, swap token — see [Google Sign-In](#google-sign-in) |

### Pass-Through

| Method | Path | Description                                    |
|--------|------|------------------------------------------------|
| ALL    | /**  | JWT validated, forwarded to tenant's api_url   |

---

## Google Sign-In

`POST /api/auth/google` — `{ idToken, tenantCode }`

Fully functional — the main-service constraint below was later relaxed specifically for this feature (see `GOOGLE_SIGNIN_AND_MIDDLEWARE_INTEGRATION.md`, repo root of `online-class-management-platform`, for the full history and setup checklist):

1. Verifies the Google ID token's signature, issuer, and audience (`GOOGLE_CLIENT_ID`) via `google-auth-library`.
2. Confirms the email is present and Google-verified (`email_verified: true`).
3. Resolves `tenantCode` to an active `TenantMaster` row (same multi-tenant model as register/login — a Google token proves *identity*, not *which tenant*).
4. Upserts `user_tenant_mapping` for this email → tenant (idempotent — this may be the first time this middleware has ever seen this email, if the user has only ever signed in with Google).
5. Forwards `{ idToken, [FORWARD_TENANT_CODE_AS]: tenantCode }` to `{api_url}{GOOGLE_PATH}` — the main service **independently re-verifies the same ID token itself** (this middleware's verification is not trusted as an auth bypass on its own) and either logs in an existing user or auto-provisions one, per its own business rules.
6. Same token-swap treatment as login/register: the main service's response envelope is preserved, only the token value(s) get replaced with a middleware session.

`GOOGLE_PATH` (env, default `/auth/google`) controls the upstream forwarding path, same pattern as `REGISTER_PATH`/`LOGIN_PATH`.

---

## JWT Payload

```ts
interface MiddlewareJwtPayload {
  sub:      string;  // user_tenant_mapping.id
  username: string;
  tenantId: string;
  apiUrl:   string;  // resolved at login, carried for full session
  jti:      string;  // Redis key — session:{jti} holds { apiUrl, upstreamToken }
}
```

The upstream token is deliberately **not** in the payload — see [Login Flow](#login-flow--apiurl-resolution). It only ever exists in Redis (server-side) and in the Authorization header swapped in on each proxied request. `jwtService.sign()` must pin `algorithm: 'HS256'` (or the chosen alg) explicitly and `jwtService.verify()` must pin the same — never accept `alg: none` or let the algorithm be inferred from the token.

---

## Proxy Middleware (core logic)

```ts
async use(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  const payload = this.jwtService.verify<MiddlewareJwtPayload>(token, { algorithms: ['HS256'] });

  const session = await this.redisService.get<{ apiUrl: string; upstreamToken: string }>(
    `session:${payload.jti}`
  );
  if (!session) {
    return res.status(401).json({ message: 'Session expired or revoked' });
  }

  // Swap to the upstream token so the main service sees its own auth
  req.headers['authorization'] = `Bearer ${session.upstreamToken}`;

  createProxyMiddleware({
    target: session.apiUrl,
    changeOrigin: true,
    ws: false,              // WebSocket/Socket.IO traffic is explicitly out of scope — see below
    proxyTimeout: 15_000,
    onError: (_err, _req, res) =>
      (res as Response).status(502).json({ message: 'Upstream unavailable' })
  })(req, res, next);
}
```

(`onError` is the http-proxy-middleware v2 API — v3 renamed this to a nested `on: { error }` object; pin whichever major version is actually installed and match its option shape.)

Global body size limit (e.g. `app.use(express.json({ limit: '1mb' }))`) must be set before this middleware to bound proxy-abuse/DoS via oversized payloads; raise per-route only where file upload pass-through genuinely needs it.

### WebSocket / real-time traffic — explicitly out of scope for the proxy

Many main services authenticate Socket.IO connections via a handshake `auth.token` payload sent inside the Socket.IO protocol layer itself, not as a rewritable HTTP header — a generic `http-proxy-middleware` header swap cannot intercept or rewrite that. Proxying WebSocket upgrades correctly also requires explicit `httpServer.on('upgrade', ...)` wiring, since upgrade requests never pass through the normal Express middleware chain that does the JWT verification.

Given that, real-time clients connect **directly** to the tenant's `apiUrl`, bypassing the middleware, using the raw upstream token. The middleware exposes one narrow endpoint for this:

```
GET /middleware/auth/upstream-session   (requires a valid, non-revoked middleware JWT)

Middleware steps:
1. Verify middleware JWT → extract jti
2. GET session:{jti} from Redis → { apiUrl, upstreamToken }
3. Return { apiUrl, upstreamToken } to the client

Client then connects: io(apiUrl, { auth: { token: upstreamToken } })
   or, if the main service supports it: io(apiUrl, { extraHeaders: { Authorization: `Bearer ${upstreamToken}` } })
```

This endpoint hands the client the same upstream credential it would have received by logging into the main service directly — it does not weaken anything, since the middleware's whole job for HTTP traffic is standing in front of that same token. Rate-limit this endpoint the same as other authenticated routes, and note it in the same audit-logging path as the rest of session issuance.

---

## Environment Variables (`.env.example`)

> These are placeholders for local dev only. `configuration.ts` must throw at boot in `NODE_ENV=production` if any of `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DB_PASSWORD`, `ADMIN_PASSWORD` still match the values shown here — see [Security Considerations](#security-considerations).

```env
# App
PORT=3000
NODE_ENV=development

# CORS — comma-separated allowlist of frontend origins; never '*'
CORS_ORIGINS=http://localhost:5173

# Middleware DB (completely separate from any main service DB)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mtm_middleware
DB_USER=postgres
DB_PASSWORD=password

# Redis (session storage: session:{jti} holds apiUrl+upstreamToken; refresh:{refreshJti} for refresh revocation)
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT — generate with `openssl rand -base64 48`, do not reuse across environments
JWT_SECRET=change_me
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=another_secret
JWT_REFRESH_EXPIRES_IN=7d

# ── Intercept config — adapt to any main service via env only ──
# Example values below match a main service mounted under a global "/api" prefix
# that itself requires a tenant/institute code on register (verify against the
# actual target main service — do not assume, these vary per backend).
REGISTER_PATH=/api/auth/register
LOGIN_PATH=/api/auth/login
UPSTREAM_REFRESH_PATH=/api/auth/refresh-token   # empty if the main service has no refresh endpoint
USERNAME_FIELD=email           # field that identifies the user in login/register body
TENANT_CODE_FIELD=tenantCode   # field the CLIENT sends to the middleware
TENANT_NAME_FIELD=tenantName   # field stripped before forwarding (new tenant only) — middleware-only concern
API_URL_FIELD=apiUrl           # field stripped before forwarding (new tenant only) — middleware-only concern
FORWARD_TENANT_CODE_AS=instituteCode  # field name forwarded upstream; empty = strip (main service has no tenant concept)
UPSTREAM_TOKEN_PATH=data.accessToken   # dot-path into the main service's response body; not always a flat field

# apiUrl SSRF guard — reject loopback/private/link-local hosts unless explicitly allowed (dev only)
ALLOW_PRIVATE_API_URLS=false

# Middleware admin credentials (bootstrap) — ADMIN_PASSWORD_HASH is a bcrypt hash, never plaintext
ADMIN_EMAIL=admin@internal.com
ADMIN_PASSWORD_HASH=$2b$12$replace_with_a_real_bcrypt_hash

# Google Sign-In — OAuth 2.0 Web Client ID (Google Cloud Console > APIs & Services > Credentials)
# Unset disables POST /api/auth/google (it responds 400). See "Google Sign-In" section above.
GOOGLE_CLIENT_ID=
```

---

## Security Considerations

| Risk                              | Mitigation                                                              |
|-----------------------------------|-------------------------------------------------------------------------|
| Rogue/internal apiUrl on register | **Mandatory**, not optional: require `https://`, resolve hostname and reject loopback/private/link-local ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 incl. cloud metadata 169.254.169.254). Rejected at registration time since `apiUrl` is persisted to `tenant_master` and reused for every future login — this is a stored SSRF target if unvalidated, not just a one-off request. |
| SSRF via proxy target             | Target always comes from DB (`tenant_master.api_url`), never from client|
| Upstream token exposure           | Never embedded in the JWT (see [JWT Payload](#jwt-payload)) — held only in Redis (`session:{jti}`), so a leaked middleware JWT is not itself a leaked upstream credential |
| Tenant squatting (code collision) | First registrant owns the code; subsequent registrants cannot change it |
| Replay of stolen MW JWT           | Redis session lookup is required on every proxied request (not just JWT signature check) + logout endpoint does `DEL session:{jti}` |
| Replay of stolen refresh token    | Refresh tokens tracked as `refresh:{refreshJti}` in Redis too; logout/revoke must delete both the access-session and refresh-session keys, not just the 15-min access token |
| Credential stuffing / brute force on login+register | Rate limiting (`@nestjs/throttler`) applied from Phase 2 onward, not deferred to a later hardening pass — these are the two endpoints attackers hit first |
| Weak/default secrets reaching prod | `configuration.ts` must fail fast at boot (throw, don't warn) if `NODE_ENV=production` and any of `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DB_PASSWORD`, `ADMIN_PASSWORD` match their `.env.example` placeholder values |
| Cross-origin credential misuse   | Explicit CORS allowlist of known frontend origins (`CORS_ORIGINS` env, comma-separated) — never `origin: '*'` combined with credentials |
| Admin bootstrap account          | `ADMIN_PASSWORD` stored/compared as a bcrypt hash, never plaintext; admin login goes through the same rate limiter as `/auth/login` |
| Alg-confusion on JWT verify      | Sign and verify both pin `algorithms: ['HS256']` explicitly; never accept an unsigned or algorithm-inferred token |
| Sensitive data in logs           | Any request/response logging or error interceptor must redact `password`, `accessToken`, `refreshToken`, `upstreamToken`, `Authorization` fields before writing |
| Oversized/slow proxy requests    | Global body size limit (e.g. 1mb) ahead of the proxy middleware; `proxyTimeout` set on `http-proxy-middleware` |
| Registration/login rejected by an already-multi-tenant main service | Don't assume the upstream main service is tenant-unaware — verify whether it has its own required tenant/institute field before stripping it. Use `FORWARD_TENANT_CODE_AS` to rename-and-forward instead of deleting when it does. |
| Direct-to-upstream token exposure via the WebSocket escape hatch | `GET /middleware/auth/upstream-session` hands out the raw upstream token for real-time clients (see [Pass-Through Flow](#pass-through-flow--all-other-requests)) — rate-limit and audit-log it identically to `/auth/login`, since it is functionally a session-issuance endpoint, not a passive read. |

---

## Implementation Phases

### Phase 1 — Scaffold
- [ ] `nest new meet-to-manage-middleware`
- [ ] Dependencies: `@nestjs/typeorm typeorm pg ioredis @nestjs/jwt @nestjs/passport passport-jwt bcrypt class-validator class-transformer http-proxy-middleware @nestjs/config @nestjs/throttler helmet`
- [ ] `configuration.ts` — typed env config with validation; **fail fast at boot** in production if secrets match `.env.example` placeholders
- [ ] Two TypeORM entities: `TenantMaster`, `UserTenantMapping`
- [ ] Initial migration
- [ ] Redis module
- [ ] Helmet + CORS allowlist (`CORS_ORIGINS`) wired into `main.ts` from day one — these are baseline, not a later hardening pass
- [ ] Global validation pipe (`whitelist: true, forbidNonWhitelisted: true`) — applied before any DTO exists, so it's enforced by construction as routes are added
- [ ] Global body size limit on the JSON body parser

### Phase 2 — Auth Intercept
- [ ] `AuthService.register()`:
  - Validate `apiUrl` on new-tenant registration: require `https://`, reject loopback/private/link-local hosts unless `ALLOW_PRIVATE_API_URLS=true` (dev only) — see SSRF row in [Security Considerations](#security-considerations)
  - Upsert tenant on `tenantCode` (create if new, use existing if found)
  - Insert `(username, tenant_id)` into `user_tenant_mapping`
  - Strip middleware-only fields (`tenantName`, `apiUrl`); rename+forward `tenantCode` as `FORWARD_TENANT_CODE_AS` if set — **verify against the real target main service's registration contract first**, don't assume it's tenant-unaware
  - Forward to main service, return response as-is
- [ ] `AuthService.login()`:
  - Resolve `api_url` from `user_tenant_mapping`
  - Forward credentials (+ mapped tenant field if configured) to main service
  - Extract upstream token via `UPSTREAM_TOKEN_PATH` (dot-path, e.g. `data.accessToken`)
  - Sign middleware JWT (payload has no upstream secret — see [JWT Payload](#jwt-payload)) with explicit `algorithm: 'HS256'`
  - Store `session:{jti}` and `refresh:{refreshJti}` in Redis (see [Login Flow](#login-flow--apiurl-resolution))
- [ ] JWT strategy (pin verify algorithm; reject `alg: none`)
- [ ] Rate limiting (`@nestjs/throttler`) on `/auth/register` and `/auth/login` — added here, not deferred, since these are the endpoints attackers hit first
- [ ] `AuthService.refresh()`: calls `UPSTREAM_REFRESH_PATH` on the main service to mint a new upstream token (see [Refresh Flow](#refresh-flow--renewing-the-upstream-token)) rather than just extending Redis TTL on the old one
- [ ] Logout endpoint: `DEL session:{jti}` **and** `DEL refresh:{refreshJti}`

### Phase 3 — Transparent Proxy
- [ ] `ProxyMiddleware`: verify JWT, look up `session:{jti}` in Redis (401 if missing/revoked), swap Authorization header, proxy with `http-proxy-middleware`
- [ ] `ws: false` — WebSocket/Socket.IO proxying is explicitly out of scope for this phase (see note under [Pass-Through Flow](#pass-through-flow--all-other-requests)); `proxyTimeout` still set for HTTP calls
- [ ] `GET /middleware/auth/upstream-session` escape-hatch endpoint so real-time clients can connect directly to `apiUrl`, bypassing the proxy
- [ ] Apply globally after auth routes are registered
- [ ] 502 error boundary for upstream failures
- [ ] Error/logging interceptor redacts `password`, `*Token`, `Authorization` fields before anything is logged

### Phase 4 — Admin Module
- [ ] Tenant list / update / deactivate
- [ ] Mapping list / deactivate
- [ ] Admin guard: `ADMIN_PASSWORD_HASH` (bcrypt) compared via `bcrypt.compare`, never plaintext; same rate limiter as `/auth/login`

### Phase 5 — Hardening & Polish
- [ ] Structured logging (confirm redaction from Phase 3 covers all sensitive fields)
- [ ] Health endpoint `/middleware/health`
- [ ] Docker Compose (redis + app only — Postgres is an existing, externally managed instance reached via `DB_HOST`/`DB_PORT` in `.env`, not run in Docker) — secrets injected via `.env`, never baked into the compose file
- [ ] Dependency audit (`npm audit`) as part of CI
