// Extracts a nested value from an object using a dot-path (e.g. "data.accessToken"),
// since upstream main services often wrap responses in an envelope rather than
// returning fields flat at the top level.
export function getByDotPath(source: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, source);
}

// Writes a value at a dot-path inside an object, creating intermediate objects
// as needed. Used to swap the upstream's own token value for the middleware's
// session token while otherwise preserving the upstream response envelope
// (e.g. { success, message, data: { user, accessToken } }) byte-for-byte, so
// existing clients that already parse that envelope keep working unmodified.
export function setByDotPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) {
    return;
  }
  const segments = path.split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}
