import type { WompiTransaction } from "../wompi/wompi-events";
import type { WompiGateway } from "../wompi/wompi.gateway";

/**
 * A Wompi transaction as `GET /v1/transactions/{id}` (or an event's
 * `data.transaction`) carries it, for the default order fixture: approved,
 * $ 89.000 COP, under the first attempt's reference.
 */
export function wompiTransaction(overrides: Partial<WompiTransaction> = {}): WompiTransaction {
  return {
    id: "1234-1700000000-00001",
    status: "APPROVED",
    reference: "AK-2026-000123-1",
    amount_in_cents: 8_900_000,
    currency: "COP",
    payment_method_type: "CARD",
    status_message: null,
    customer_email: "customer@example.com",
    created_at: "2026-10-06T12:00:00.000Z",
    finalized_at: "2026-10-06T12:00:05.000Z",
    ...overrides,
  };
}

/**
 * In-memory `WompiGateway`. Implements the real port, so a drifting signature
 * fails to compile rather than lying at runtime.
 */
export class FakeWompiGateway implements WompiGateway {
  readonly transactions = new Map<string, WompiTransaction>();
  readonly lookups: string[] = [];
  /** Set to make the next lookup throw (Wompi down). */
  failNext: Error | null = null;

  seed(transaction: WompiTransaction): void {
    this.transactions.set(transaction.id, transaction);
  }

  async getTransaction(transactionId: string): Promise<WompiTransaction | null> {
    this.lookups.push(transactionId);
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    return this.transactions.get(transactionId) ?? null;
  }
}
