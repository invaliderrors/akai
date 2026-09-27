/**
 * An injectable clock.
 *
 * Erasure writes a tombstone timestamp and a set of revocation timestamps that
 * must agree, and tests assert on them. Calling `new Date()` inline would make
 * those assertions either untestable or dependent on wall-clock timing, which is
 * how a suite acquires a test that fails once a fortnight on a slow CI runner.
 */
export const CLOCK = "akai:clock";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
