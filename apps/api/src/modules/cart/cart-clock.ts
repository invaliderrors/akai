/**
 * Time, as an injectable dependency.
 *
 * Cart expiry is a security-relevant rule (a stale token must stop working), and
 * a rule that can only be tested by making the suite sleep for 30 days is a rule
 * that does not get tested. Injecting the clock makes "this cart expired one
 * millisecond ago" an ordinary assertion.
 */
export interface CartClock {
  now(): Date;
}

export const CART_CLOCK = Symbol("CART_CLOCK");

export const systemClock: CartClock = {
  now: (): Date => new Date(),
};
