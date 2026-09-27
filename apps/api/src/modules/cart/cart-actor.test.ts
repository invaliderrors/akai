import { describe, expect, it } from "vitest";
import { PRINCIPAL_REQUEST_KEY, writePrincipal } from "../auth/security/principal";
import { extractCartActor } from "./cart-actor";
import { CART_TOKEN_HEADER } from "./cart.constants";

const CUSTOMER_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("extractCartActor", () => {
  it("reads a customerId-shaped principal", () => {
    const actor = extractCartActor({ [PRINCIPAL_REQUEST_KEY]: { customerId: CUSTOMER_ID }, headers: {} });
    expect(actor.customerId).toBe(CUSTOMER_ID);
  });

  it("reads a JWT `sub`-shaped principal", () => {
    const actor = extractCartActor({ [PRINCIPAL_REQUEST_KEY]: { sub: CUSTOMER_ID }, headers: {} });
    expect(actor.customerId).toBe(CUSTOMER_ID);
  });

  it("ignores extra properties the auth layer attaches", () => {
    const actor = extractCartActor({
      [PRINCIPAL_REQUEST_KEY]: { customerId: CUSTOMER_ID, role: "ADMIN", sessionId: "abc" },
      headers: {},
    });
    expect(actor.customerId).toBe(CUSTOMER_ID);
  });

  it("returns an anonymous actor when there is no session", () => {
    const actor = extractCartActor({ headers: {} });
    expect(actor.customerId).toBeNull();
    expect(actor.cartToken).toBeNull();
  });

  /**
   * A principal is only trusted if it actually looks like one. A non-uuid
   * `customerId` means something upstream is wrong, and the safe reading of a
   * malformed principal is "anonymous", never "some customer".
   */
  it.each([
    ["a non-uuid customerId", { customerId: "1" }],
    ["a numeric customerId", { customerId: 42 }],
    ["a null customerId", { customerId: null }],
    ["an empty object", {}],
    ["a boolean", true],
    ["a string", "customer"],
    ["null", null],
    ["an array", [CUSTOMER_ID]],
  ])("treats %s as anonymous", (_label, user) => {
    expect(extractCartActor({ user, headers: {} }).customerId).toBeNull();
  });

  describe("cart token header", () => {
    it("reads the token header", () => {
      const actor = extractCartActor({
        headers: { [CART_TOKEN_HEADER]: "a".repeat(43) },
      });
      expect(actor.cartToken).toBe("a".repeat(43));
    });

    it("trims surrounding whitespace", () => {
      const actor = extractCartActor({
        headers: { [CART_TOKEN_HEADER]: `  ${"a".repeat(43)}  ` },
      });
      expect(actor.cartToken).toBe("a".repeat(43));
    });

    /**
     * A repeated header arrives as an array. Picking the first element would
     * let a caller who controls a proxy present two tokens and have different
     * layers disagree about which one counts, so a duplicate is no token.
     */
    it("refuses a duplicated token header rather than picking one", () => {
      const actor = extractCartActor({
        headers: { [CART_TOKEN_HEADER]: ["a".repeat(43), "b".repeat(43)] },
      });
      expect(actor.cartToken).toBeNull();
    });

    it.each([
      ["missing", {}],
      ["empty", { [CART_TOKEN_HEADER]: "" }],
      ["whitespace only", { [CART_TOKEN_HEADER]: "   " }],
      ["non-string", { [CART_TOKEN_HEADER]: 12_345 }],
      ["no headers object", undefined],
    ])("yields a null token when the header is %s", (_label, headers) => {
      expect(extractCartActor({ headers }).cartToken).toBeNull();
    });

    it("survives a request that is not an object at all", () => {
      expect(extractCartActor(undefined).customerId).toBeNull();
      expect(extractCartActor("nope").cartToken).toBeNull();
    });
  });

  /**
   * REGRESSION. The reader used `request.user` while the auth layer writes
   * `akaiPrincipal`, so the match never happened: every authenticated cart and
   * checkout resolved as anonymous and a signed-in customer's order was created
   * as a GUEST order that never showed up in their account. Nothing threw — the
   * customerId was simply always null.
   *
   * The old tests hid it by constructing `{ user: … }` by hand, a shape
   * production never produces. This one drives the ACTUAL writer instead, so the
   * two halves cannot drift apart again.
   */
  it("reads a principal put there by the auth layer's own writer", () => {
    const request: Record<string, unknown> = { headers: {} };
    writePrincipal(request, {
      customerId: CUSTOMER_ID,
      sessionId: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      role: "CUSTOMER",
      twoFactorAssertedAt: null,
    });

    expect(extractCartActor(request).customerId).toBe(CUSTOMER_ID);
  });
});
