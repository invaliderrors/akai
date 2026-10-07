import { wompiTransactionIdSchema, type OrderStatusResponse } from "@akai/contracts";

/**
 * What the processing page shows, decided from the polled status alone.
 *
 *   paid     — the money settled.
 *   review   — PAYMENT_MISMATCH: Wompi reported something we refused to accept,
 *              so money MAY have moved and only a person can resolve it. Telling
 *              this customer "the payment didn't go through" could be false.
 *   failed   — declined / voided / errored / cancelled.
 *   waiting  — keep polling.
 */
export type ProcessingOutcome = "waiting" | "paid" | "review" | "failed";

export function processingOutcome(status: OrderStatusResponse): ProcessingOutcome {
  if (status.isPaid) return "paid";
  if (status.status === "PAYMENT_MISMATCH") return "review";
  if (status.isTerminal) return "failed";
  return "waiting";
}

/**
 * Wompi appends `?id=<transactionId>` to the return URL. Validated here so a
 * hand-edited URL never reaches the API as anything but a well-shaped id — and
 * the API still treats it only as a pointer it looks up with its own key.
 */
export function wompiTransactionIdFrom(value: string | null): string | null {
  if (value === null) return null;
  const parsed = wompiTransactionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
