/**
 * Time as an injected dependency.
 *
 * Token expiry, lockout windows, TOTP steps and refresh rotation are all
 * time-dependent, and a test that proves "an expired token is rejected" by
 * sleeping for 15 minutes is a test nobody runs. Injecting the clock makes
 * every one of those boundaries assertable in microseconds.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol("CLOCK");

export const systemClock: Clock = {
  now: () => new Date(),
};
