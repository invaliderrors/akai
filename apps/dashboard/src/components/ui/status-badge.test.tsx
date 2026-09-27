import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { STATUS_TONE, type StatusDomain } from "@/lib/status";

import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

/**
 * These tests exist for one reason: the badge must say WHICH thing is pending,
 * cancelled or failed.
 *
 * Four member names are shared across the enums, and the three superseded
 * badges keyed on the member alone — so a dead payment ATTEMPT and a cancelled
 * ORDER rendered the same grey "Cancelado", and an operator could not tell from
 * the list which one they were looking at. The rewordings live in the message
 * catalogue and the (domain, member) keying lives in `lib/status`; this file is
 * where the two are proved to meet, against the REAL `es.json` and `en.json`
 * rather than a fixture, because a fixture is exactly the thing that would keep
 * passing after a translator flattened "Pago cancelado" back to "Cancelado".
 */

type AppLocale = "es" | "en";

const LOCALES: readonly AppLocale[] = ["es", "en"];

/** Spelled out rather than derived, so a thirteenth domain fails the count below. */
const DOMAINS: readonly StatusDomain[] = [
  "order",
  "payment",
  "shipment",
  "return",
  "email",
  "job",
  "product",
  "role",
  "discount",
  "stock",
  "emailVerification",
  "internalNote",
];

interface RenderedStatuses {
  readonly container: HTMLElement;
  /** One entry per badge, in the order the props were given. */
  readonly labels: readonly string[];
  /**
   * Everything next-intl complained about while rendering.
   *
   * Supplying `onError` replaces the library's default `console.error`, so a
   * missing message is captured here instead of scrolling past in the test
   * output — and an empty array is a real assertion that every member the tone
   * table knows about also has a translation in this locale. Nothing else in
   * the suite covers that drift: the catalogue and `STATUS_TONE` are two files
   * that no type connects.
   */
  readonly intlErrors: readonly string[];
}

function renderStatuses(
  items: readonly StatusBadgeProps[],
  locale: AppLocale = "es",
): RenderedStatuses {
  const intlErrors: string[] = [];

  const { container } = render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "es" ? esMessages : enMessages}
      onError={(error) => {
        intlErrors.push(`${error.code}: ${error.message}`);
      }}
    >
      {items.map((item, index) => (
        <StatusBadge key={`${item.domain}.${item.value}.${index}`} {...item} />
      ))}
    </NextIntlClientProvider>,
  );

  // The provider renders no DOM of its own, so each badge capsule is a direct
  // child of the container — which is also how the labels stay in prop order.
  const capsules = Array.from(container.querySelectorAll(":scope > span"));

  return {
    container,
    labels: capsules.map((capsule) => capsule.textContent ?? ""),
    intlErrors,
  };
}

/** The capsule carries the tone classes; `noUncheckedIndexedAccess` makes the miss explicit. */
function capsuleAt(container: HTMLElement, index: number): Element {
  const capsule = Array.from(container.querySelectorAll(":scope > span"))[index];
  if (capsule === undefined) {
    throw new Error(`no badge rendered at index ${index}`);
  }
  return capsule;
}

describe("<StatusBadge /> — the cross-domain collisions", () => {
  it("keeps a pending ORDER apart from a pending SHIPMENT", () => {
    // The order has not been paid for; the shipment has not been handed to the
    // carrier. Same enum member, unrelated facts, and both appear in the same
    // order list — one column apart.
    const { labels } = renderStatuses([
      { domain: "order", value: "PENDING" },
      { domain: "shipment", value: "PENDING" },
    ]);

    expect(labels).toEqual(["Pendiente", "Envío pendiente"]);
  });

  it("keeps a cancelled ORDER apart from a cancelled PAYMENT attempt", () => {
    // This is the dangerous one: a cancelled attempt is routine (the customer
    // closed the tab) and the order behind it is untouched, while a cancelled
    // order is the whole thing called off.
    const { labels } = renderStatuses([
      { domain: "order", value: "CANCELLED" },
      { domain: "payment", value: "CANCELLED" },
    ]);

    expect(labels).toEqual(["Cancelado", "Pago cancelado"]);
  });

  it("keeps a failed ORDER apart from a failed PAYMENT attempt", () => {
    const { labels } = renderStatuses([
      { domain: "order", value: "FAILED" },
      { domain: "payment", value: "FAILED" },
    ]);

    expect(labels).toEqual(["Fallido", "Pago fallido"]);
  });

  it("disambiguates in English too, not only in the default locale", () => {
    // The rewordings had to be made twice. Leaving `en` alone would have kept
    // the exact collision the Spanish rewordings exist to break, on the locale
    // an operator working in English actually sees.
    const { labels } = renderStatuses(
      [
        { domain: "order", value: "PENDING" },
        { domain: "shipment", value: "PENDING" },
        { domain: "order", value: "CANCELLED" },
        { domain: "payment", value: "CANCELLED" },
        { domain: "order", value: "FAILED" },
        { domain: "payment", value: "FAILED" },
      ],
      "en",
    );

    expect(labels).toEqual([
      "Pending",
      "Shipment pending",
      "Cancelled",
      "Payment cancelled",
      "Failed",
      "Payment failed",
    ]);
  });

  it("separates a failed send from a failed order by TONE, not by wording", () => {
    // The fourth collision is not resolved with words: "Fallido" is the right
    // label for both. It is resolved by severity — a failed order is terminal,
    // a failed send retries — and that is only reachable because the domain is
    // part of the lookup key.
    const { container, labels } = renderStatuses([
      { domain: "order", value: "FAILED" },
      { domain: "email", value: "FAILED" },
    ]);

    expect(labels).toEqual(["Fallido", "Fallido"]);
    expect(capsuleAt(container, 0).className).toContain("bg-[var(--danger-fill)]");
    expect(capsuleAt(container, 1).className).toContain("bg-[var(--warning-fill)]");
  });

  it("draws order PAYMENT_MISMATCH as the attention state", () => {
    const { container, labels } = renderStatuses([
      { domain: "order", value: "PAYMENT_MISMATCH" },
    ]);

    expect(labels).toEqual(["Importe no coincide"]);
    expect(capsuleAt(container, 0).className).toContain("bg-[var(--attention-fill)]");
    // The symbol replaces the dot here. Money may already have moved and a
    // human has to rule on it, so the state is signalled twice over.
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("<StatusBadge /> — the catalogue covers the tone table", () => {
  it("names every domain lib/status declares", () => {
    expect(DOMAINS).toHaveLength(Object.keys(STATUS_TONE).length);
  });

  describe.each(LOCALES)("in %s", (locale: AppLocale) => {
    it.each(DOMAINS)("labels every %s member", (domain: StatusDomain) => {
      const members = Object.keys(STATUS_TONE[domain]);
      const { labels, intlErrors } = renderStatuses(
        members.map((value) => ({ domain, value })),
        locale,
      );

      expect(members.length).toBeGreaterThan(0);
      expect(labels).toHaveLength(members.length);
      // A member with a tone but no translation renders as its own key path —
      // `status.order.PAID` sitting in a table next to a euro figure. Both the
      // captured error and the shape of the text catch it.
      expect(intlErrors).toEqual([]);
      for (const label of labels) {
        expect(label).not.toBe("");
        expect(label.startsWith("status.")).toBe(false);
      }
    });
  });
});

describe("<StatusBadge /> — a value it does not recognise", () => {
  it("shows the raw member neutrally rather than a message key", () => {
    // What a rolling deploy looks like: the API has shipped a status this
    // build has never heard of. Blank would read as "no status"; `t()` would
    // print `status.order.ON_HOLD`. The member itself is the honest answer.
    const { container, labels, intlErrors } = renderStatuses([
      { domain: "order", value: "ON_HOLD" },
    ]);

    expect(labels).toEqual(["ON_HOLD"]);
    expect(capsuleAt(container, 0).className).toContain("bg-[var(--neutral-fill)]");
    // `t()` is never called for an unresolved member, so next-intl never sees
    // a missing message and nothing is logged.
    expect(intlErrors).toEqual([]);
  });

  it("does not borrow another domain's label for a member it does not own", () => {
    // PAID belongs to the order enum and not to the payment enum. A flat
    // member-keyed lookup would happily label a payment "Pagado"; this must
    // fall back instead.
    const { labels } = renderStatuses([{ domain: "payment", value: "PAID" }]);

    expect(labels).toEqual(["PAID"]);
  });

  it("survives a value that names an Object.prototype member", () => {
    // The lookup is a Map for this reason: `STATUS_TONE.order["constructor"]`
    // on a plain object returns a function, and the badge would render
    // whatever that stringifies to.
    const { labels } = renderStatuses([
      { domain: "order", value: "constructor" },
      { domain: "order", value: "__proto__" },
    ]);

    expect(labels).toEqual(["constructor", "__proto__"]);
  });
});

describe("<StatusBadge /> — pass-through to Badge", () => {
  it("leaves the density default to Badge", () => {
    const { container } = renderStatuses([{ domain: "order", value: "PAID" }]);

    expect(capsuleAt(container, 0).className).toContain("h-[24px]");
  });

  it("renders compact when asked", () => {
    const { container } = renderStatuses([
      { domain: "order", value: "PAID", density: "compact" },
    ]);

    expect(capsuleAt(container, 0).className).toContain("h-[18px]");
  });

  it("switches to the on-accent treatment for a selected row", () => {
    const { container, labels } = renderStatuses([
      { domain: "order", value: "PAID", onAccent: true },
    ]);

    const className = capsuleAt(container, 0).className;
    expect(className).toContain("text-[var(--label-on-accent)]");
    expect(className).not.toContain("bg-[var(--success-fill)]");
    // The tint is gone; the label is what carries the state across the accent.
    expect(labels).toEqual(["Pagado"]);
  });

  it("appends a caller class", () => {
    const { container } = renderStatuses([
      { domain: "product", value: "ACTIVE", className: "ml-auto" },
    ]);

    expect(capsuleAt(container, 0).className).toContain("ml-auto");
  });
});
