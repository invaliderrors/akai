import type { EmailPort, SendEmailInput, SendEmailResult } from "@akai/contracts";

/**
 * In-memory EmailPort.
 *
 * Bound in every test and in api-e2e. NO TEST CAN REACH A REAL INBOX, because
 * no test ever sees the Resend adapter — the safety comes from the wiring, not
 * from remembering to stub.
 */
export class FakeEmailPort implements EmailPort {
  private readonly sent: SendEmailInput[] = [];
  private failNext: Error | null = null;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.sent.push(input);
    return { providerMessageId: `fake-${this.sent.length}` };
  }

  /** Everything sent so far, in order. */
  get messages(): readonly SendEmailInput[] {
    return this.sent;
  }

  /** Messages for one template — the usual assertion target. */
  byTemplate(templateKey: SendEmailInput["templateKey"]): readonly SendEmailInput[] {
    return this.sent.filter((message) => message.templateKey === templateKey);
  }

  /**
   * Count sends for one order+template pair.
   *
   * This is the assertion that proves email idempotency: a provider webhook
   * retry must NOT produce a second order confirmation, and this is how a test
   * says so.
   */
  countFor(orderId: string, templateKey: SendEmailInput["templateKey"]): number {
    return this.sent.filter(
      (message) => message.orderId === orderId && message.templateKey === templateKey,
    ).length;
  }

  /** Arm a single failure, to exercise retry and DLQ paths. */
  failOnce(error: Error = new Error("Email provider unavailable")): void {
    this.failNext = error;
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  }
}
