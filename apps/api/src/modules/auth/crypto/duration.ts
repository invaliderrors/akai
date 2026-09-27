/**
 * Duration strings ("15m", "30d") -> milliseconds.
 *
 * The config schema (libs/config) already constrains these to /^\d+[smhd]$/, so
 * this parser exists to TURN a validated string into a number, not to re-police
 * it. It still throws on a malformed value rather than defaulting, because a
 * silently-defaulted token TTL is a security control that looks configured and
 * is not.
 */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) {
    throw new Error(
      `Invalid duration "${value}": expected a number followed by s, m, h or d (e.g. "15m")`,
    );
  }

  const [, rawAmount, rawUnit] = match;
  if (rawAmount === undefined || rawUnit === undefined) {
    throw new Error(`Invalid duration "${value}"`);
  }

  const unitMs = UNIT_MS[rawUnit];
  if (unitMs === undefined) {
    throw new Error(`Invalid duration unit "${rawUnit}" in "${value}"`);
  }

  const amount = Number.parseInt(rawAmount, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Invalid duration amount in "${value}": must be a positive integer`);
  }

  return amount * unitMs;
}
