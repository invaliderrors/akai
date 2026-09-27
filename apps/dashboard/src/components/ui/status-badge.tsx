import { useTranslations } from "next-intl";

import { resolveStatus, type StatusDomain } from "@/lib/status";

import { Badge, type BadgeDensity } from "./badge";

/**
 * THE status badge. One component for all twelve badged vocabularies.
 *
 * It replaces `account/status-badge.tsx`'s three near-identical exports
 * (`OrderStatusBadge`, `PaymentStatusBadge`, `ShipmentStatusBadge`) AND the
 * hand-written `tone={...}` expressions scattered down the ten admin pages —
 * `product.status === "ACTIVE" ? "positive" : "neutral"` in two files,
 * `ORDER_STATUS_TONE` in three, `EMAIL_STATUS_TONE`, `JOB_STATE_TONE`,
 * `STATE_TONE`, `STOCK_TONE`. Every one of those had to be kept in step by
 * hand, and they were not: a PAID order was one green in the account area and
 * a different green in admin.
 *
 * `domain` IS REQUIRED, AND THAT IS THE WHOLE POINT — not a convenience prop.
 * Four member names collide across the enums and do not mean the same thing:
 * PENDING (order / shipment / job), CANCELLED (order / payment), FAILED
 * (order / payment / email) and DELIVERED (order / shipment / email). A badge
 * keyed on the member alone has to guess, and it guesses the same way for a
 * cancelled ORDER as for one dead payment ATTEMPT against an order that is
 * fine. Passing the domain makes that structurally impossible: the tone and
 * the message key are both looked up at (domain, member) in `lib/status`, so
 * "Cancelado" and "Pago cancelado" are different strings by construction and
 * not by a translator having noticed.
 *
 * NO `"use client"`, DELIBERATELY. `next-intl` ships a `react-server`
 * condition, so `useTranslations` here resolves to the RSC implementation in a
 * server component and to the context hook when this file is pulled into a
 * client bundle by a client caller. Both worlds render status badges — the
 * admin tables are async server components, `account/order-list.tsx` is a
 * client component — and marking this file `"use client"` would push a
 * hydration boundary into every row of every table in the product to render
 * a span that has no state, no effect and no handler.
 */

export interface StatusBadgeProps {
  readonly domain: StatusDomain;
  /**
   * The raw enum member off the wire — `"PAID"`, `"IN_TRANSIT"`, `"low"`.
   *
   * Typed `string` rather than `StatusMember<D>` because almost every caller
   * holds a value narrowed by a zod parse several frames away, and re-earning
   * that narrowing at each call site would mean either a cast (forbidden here)
   * or twelve overloads. `resolveStatus` does the narrowing once, without
   * throwing — see the fallback below for what an unknown member renders as.
   */
  readonly value: string;
  /** Passed straight through; `Badge` owns the default (comfortable). */
  readonly density?: BadgeDensity;
  /** For a table row filled with `--accent`, where every tone tint vanishes. */
  readonly onAccent?: boolean;
  readonly className?: string;
}

export function StatusBadge({ domain, value, density, onAccent, className }: StatusBadgeProps) {
  // Root namespace, not `useTranslations("status")`: `resolveStatus` returns
  // the FULL key path it built with `messageKey`, so the namespace and the
  // domain are joined in exactly one place and cannot drift apart here.
  const t = useTranslations();
  const resolved = resolveStatus(domain, value);

  /*
   * THE UNKNOWN-MEMBER FALLBACK: a neutral capsule carrying the raw value.
   *
   * This is reachable in one situation — the API has shipped an enum member
   * that this deployment does not know yet, which is a normal few minutes
   * during a rolling deploy. The two alternatives are both worse. Rendering
   * nothing leaves a blank cell in the "Estado" column, which reads as "this
   * order has no status" rather than "this dashboard is behind". Calling `t()`
   * unconditionally prints the key path itself — next-intl renders a missing
   * message as `status.order.ON_HOLD` — which lands a developer-facing string
   * next to a euro figure in front of a customer. So the raw member is shown:
   * ugly, honest, greppable, and never a message we invented.
   *
   * `neutral`, because an unrecognised state is not knowably bad; a `warning`
   * tint would raise an alarm about what is usually a routine new member.
   */
  const tone = resolved === null ? "neutral" : resolved.tone;
  const label = resolved === null ? value : t(resolved.key);

  return (
    <Badge
      tone={tone}
      label={label}
      {...(density === undefined ? {} : { density })}
      {...(onAccent === undefined ? {} : { onAccent })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
