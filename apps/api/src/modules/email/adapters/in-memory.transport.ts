import {
  EmailDeliveryError,
  type EmailTransport,
  type RenderedMessage,
  type TransportResult,
} from "../email.port";

/**
 * THE TEST DOUBLE other modules bind.
 *
 * Lives in the module (not in @akai/testing) because it doubles this module's
 * OWN driven port, `EmailTransport`, which is deliberately not part of the
 * shared contract surface. @akai/testing's `FakeEmailPort` doubles the
 * application-facing `EmailPort` and remains the right double for a module that
 * only depends on the interface.
 *
 * Bind it with:
 *   Test.createTestingModule({ imports: [EmailModule] })
 *     .overrideProvider(EMAIL_TRANSPORT).useValue(new InMemoryEmailTransport())
 *
 * Overriding the TOKEN — rather than stubbing EmailService — means the test
 * still exercises real rendering, real escaping, real idempotency and the real
 * event log. Stubbing the service would make all four untested.
 */
export class InMemoryEmailTransport implements EmailTransport {
  readonly name = "in-memory";

  private readonly delivered: RenderedMessage[] = [];
  private queuedFailures: EmailDeliveryError[] = [];

  async send(message: RenderedMessage): Promise<TransportResult> {
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }

    this.delivered.push(message);
    return { providerMessageId: `in-memory-${this.delivered.length}` };
  }

  /** Everything actually delivered, in order. */
  get messages(): readonly RenderedMessage[] {
    return this.delivered;
  }

  get lastMessage(): RenderedMessage | undefined {
    return this.delivered[this.delivered.length - 1];
  }

  /** Messages to one recipient — the usual assertion in another module's test. */
  to(recipient: string): readonly RenderedMessage[] {
    const needle = recipient.toLowerCase();
    return this.delivered.filter((message) => message.to.toLowerCase() === needle);
  }

  /**
   * Arm N consecutive failures. Exercises the retry ladder: two retryable
   * failures then success proves backoff recovers, three proves it gives up and
   * records FAILED rather than hanging.
   */
  failNext(count: number, error?: EmailDeliveryError): void {
    for (let index = 0; index < count; index += 1) {
      this.queuedFailures.push(
        error ?? new EmailDeliveryError("Simulated provider outage", true, 503),
      );
    }
  }

  /** Arm a permanent failure — the "do not retry this" path. */
  failPermanently(message = "Simulated invalid recipient"): void {
    this.queuedFailures.push(new EmailDeliveryError(message, false, 422));
  }

  reset(): void {
    this.delivered.length = 0;
    this.queuedFailures = [];
  }
}
