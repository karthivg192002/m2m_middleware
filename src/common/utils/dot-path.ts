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
