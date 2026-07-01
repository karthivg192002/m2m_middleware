// The upstream token is deliberately NOT in this payload — it lives only in
// Redis (session:{jti}). A leaked middleware JWT is therefore just a pointer,
// not a leaked upstream credential. See IMPLEMENTATION_PLAN.md "JWT Payload".
export interface MiddlewareJwtPayload {
  sub: string; // user_tenant_mapping.id
  username: string;
  tenantId: string;
  apiUrl: string; // resolved at login, carried for the full session
  jti: string; // Redis key — session:{jti} holds { apiUrl, upstreamToken }
}

export interface RefreshJwtPayload {
  sub: string;
  refreshJti: string;
}

export interface SessionRecord {
  apiUrl: string;
  upstreamToken: string;
}

export interface RefreshRecord {
  userId: string;
  tenantId: string;
  upstreamRefreshToken?: string;
}
