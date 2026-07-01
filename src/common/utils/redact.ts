const SENSITIVE_KEYS = new Set([
  'password',
  'accesstoken',
  'refreshtoken',
  'upstreamtoken',
  'authorization',
  'jwt_secret',
  'jwt_refresh_secret',
  'admin_password_hash',
]);

// Recursively redacts known-sensitive keys before anything is logged. Any
// interceptor/logger that might include request/response bodies must run
// values through this first — see Security Considerations "Sensitive data in logs".
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(entryValue),
      ]),
    );
  }
  return value;
}
