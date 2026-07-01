const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

// Parses simple durations like "15m", "24h", "7d" into seconds, for Redis TTLs
// that must match the corresponding JWT expiry.
export function parseDurationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration format: ${value} (expected e.g. "15m", "24h", "7d")`);
  }
  const [, amount, unit] = match;
  return parseInt(amount, 10) * UNIT_SECONDS[unit];
}
