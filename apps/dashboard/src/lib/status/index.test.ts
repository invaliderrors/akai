import { describe, expect, it } from "vitest";
import {
  emailStatusSchema,
  jobStateSchema,
  orderStatusSchema,
  paymentStatusSchema,
  productStatusSchema,
  returnStatusSchema,
  roleSchema,
  shipmentStatusSchema,
} from "@akai/contracts";
import type { DiscountState } from "@/lib/admin/discount-display";
import type { StockState } from "@/lib/admin/inventory-display";
import {
  STATUS_TONE,
  messageKey,
  resolveStatus,
  type BadgeTone,
  type EmailVerificationState,
  type NoteVisibility,
} from "./index";

/**
 * These tests are the reason the tone maps were centralised, so they assert
 * TOTALITY rather than a sample: every member of every badged vocabulary has a
 * tone, and no vocabulary has grown a member that no enum backs.
 *
 * They also absorb the coverage that lived in `inventory-display.test.ts`,
 * `job-display.test.ts` and `order-status.test.ts` before those files handed
 * their tone maps over — a deleted named export is an import-time failure, and
 * losing the assertions with it would read as a green regression.
 */

const TONES: readonly BadgeTone[] = [
  "neutral",
  "progress",
  "success",
  "warning",
  "danger",
  "attention",
];

describe("STATUS_TONE — totality over the contract enums", () => {
  const cases = [
    ["order", orderStatusSchema.options, STATUS_TONE.order],
    ["payment", paymentStatusSchema.options, STATUS_TONE.payment],
    ["shipment", shipmentStatusSchema.options, STATUS_TONE.shipment],
    ["return", returnStatusSchema.options, STATUS_TONE.return],
    ["email", emailStatusSchema.options, STATUS_TONE.email],
    ["job", jobStateSchema.options, STATUS_TONE.job],
    ["product", productStatusSchema.options, STATUS_TONE.product],
    ["role", roleSchema.options, STATUS_TONE.role],
  ] as const;

  for (const [domain, options, tones] of cases) {
    it(`covers every ${domain} member and invents none`, () => {
      const keys: readonly string[] = Object.keys(tones);

      // Both directions. A missing member is the failure the `Record` type
      // already catches at compile time; an EXTRA key is the one it does not —
      // a member removed from a contract enum would otherwise linger here with
      // a translation nobody can reach.
      expect([...keys].sort()).toEqual([...options].sort());

      for (const member of keys) {
        const resolved = resolveStatus(domain, member);
        expect(resolved).not.toBeNull();
        expect(TONES).toContain(resolved?.tone);
      }
    });
  }
});

describe("STATUS_TONE — the four derived vocabularies", () => {
  it("covers the discount states the coupon list derives", () => {
    // Written out rather than read from a schema because there is no schema:
    // the API has no `status` column and `resolveState` computes these from
    // deletedAt/endsAt/startsAt/remainingRedemptions.
    const expected: readonly DiscountState[] = [
      "ACTIVE",
      "SCHEDULED",
      "EXPIRED",
      "EXHAUSTED",
      "ARCHIVED",
    ];
    expect(Object.keys(STATUS_TONE.discount).sort()).toEqual([...expected].sort());
  });

  it("covers the stock states the inventory list derives", () => {
    const expected: readonly StockState[] = ["untracked", "out", "low", "backorder", "ok"];
    expect(Object.keys(STATUS_TONE.stock).sort()).toEqual([...expected].sort());
  });

  it("covers both email-verification states", () => {
    const expected: readonly EmailVerificationState[] = ["verified", "unverified"];
    expect(Object.keys(STATUS_TONE.emailVerification).sort()).toEqual([...expected].sort());
  });

  it("covers both note visibilities", () => {
    const expected: readonly NoteVisibility[] = ["internal", "customer"];
    expect(Object.keys(STATUS_TONE.internalNote).sort()).toEqual([...expected].sort());
  });
});

describe("the tones that carry a documented argument", () => {
  it("keeps DEAD louder than RETRYING", () => {
    // Absorbed from job-display.test.ts. A retrying job may still succeed on its
    // own; a dead one never will — nothing drains it again without an operator,
    // so the two must not share a colour.
    expect(STATUS_TONE.job.DEAD).toBe("danger");
    expect(STATUS_TONE.job.RETRYING).toBe("warning");
  });

  it("keeps an untracked variant as loud as an empty one", () => {
    // Absorbed from inventory-display.test.ts. A variant with no inventory
    // record shows zero everywhere, which reads as sold out — but sold out is
    // fixed by restocking and this is fixed by creating the record.
    expect(STATUS_TONE.stock.untracked).toBe("danger");
  });

  it("keeps a bounce and a complaint louder than our own failed send", () => {
    // Absorbed from email-display.ts's tone map. A complaint damages sending
    // reputation for every other customer; FAILED is ours and retries.
    expect(STATUS_TONE.email.BOUNCED).toBe("danger");
    expect(STATUS_TONE.email.COMPLAINED).toBe("danger");
    expect(STATUS_TONE.email.FAILED).toBe("warning");
  });

  it("does not let a cancelled payment attempt read like a cancelled order", () => {
    // The collision that forces the (domain, member) key. Both are `neutral`
    // here, but they resolve through different message keys, and nothing may
    // ever collapse them into one lookup.
    expect(messageKey("order", "CANCELLED")).toBe("status.order.CANCELLED");
    expect(messageKey("payment", "CANCELLED")).toBe("status.payment.CANCELLED");
  });
});

describe("the attention cap", () => {
  /** Every (domain, member) pair whose tone is `attention`. */
  const attentionEntries = Object.entries<Readonly<Record<string, BadgeTone>>>(
    STATUS_TONE,
  ).flatMap(([domain, members]) =>
    Object.entries(members)
      .filter(([, tone]) => tone === "attention")
      .map(([member]) => `${domain}.${member}`),
  );

  it("is spent on exactly two states, and these two", () => {
    // Structural, not advisory. `attention` is a solid red fill with a warning
    // glyph — the loudest thing the dashboard draws — and a third use makes all
    // three read as decoration. Adding one has to fail here first, so it gets
    // argued rather than merged.
    expect(attentionEntries.sort()).toEqual(["order.PAYMENT_MISMATCH", "stock.out"]);
  });

  it("does not let a mismatch share a tone with an ordinary unpaid order", () => {
    // Money may already have moved for an amount we never agreed to, and only a
    // human takes the order out of that state.
    expect(STATUS_TONE.order.PAYMENT_MISMATCH).toBe("attention");
    expect(STATUS_TONE.order.AWAITING_PAYMENT).toBe("warning");
  });
});

describe("messageKey", () => {
  it("builds the catalogue path the status namespace is shaped around", () => {
    expect(messageKey("order", "PAID")).toBe("status.order.PAID");
    expect(messageKey("stock", "backorder")).toBe("status.stock.backorder");
    expect(messageKey("emailVerification", "unverified")).toBe(
      "status.emailVerification.unverified",
    );
  });
});

describe("resolveStatus", () => {
  it("narrows a raw string against its domain", () => {
    expect(resolveStatus("order", "PAID")).toEqual({
      tone: "success",
      key: "status.order.PAID",
    });
  });

  it("returns null for a member of a DIFFERENT domain", () => {
    // The whole point of the domain key: `untracked` is a real status, just not
    // an order one, and a flat lookup would have found it.
    expect(resolveStatus("order", "untracked")).toBeNull();
    expect(resolveStatus("stock", "PAID")).toBeNull();
  });

  it("returns null rather than reaching an inherited property", () => {
    // The lookup key is an untrusted string. Indexing a plain object with
    // "constructor" or "__proto__" returns something truthy, and a badge would
    // render whatever that stringifies to.
    expect(resolveStatus("order", "constructor")).toBeNull();
    expect(resolveStatus("order", "__proto__")).toBeNull();
    expect(resolveStatus("order", "toString")).toBeNull();
  });

  it("returns null for the empty string and for a raw enum-shaped guess", () => {
    expect(resolveStatus("order", "")).toBeNull();
    expect(resolveStatus("order", "SETTLED")).toBeNull();
  });
});
