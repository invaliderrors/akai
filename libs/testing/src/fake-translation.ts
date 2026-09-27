import type {
  TranslateRequest,
  TranslationFailureReason,
  TranslationOutcome,
  TranslationPort,
} from "@akai/contracts";

/**
 * In-memory TranslationPort.
 *
 * Bound wherever a suite exercises the translation surface, so NO TEST CAN
 * REACH DEEPL — the safety comes from the wiring rather than from remembering
 * to stub `fetch`. The API's own gateway is only ever constructed by
 * `createTranslationGateway`, which needs a key that no test environment sets.
 *
 * The success path MARKS the text (`[en] …`) instead of echoing it. An echo
 * would let "the field was replaced by its translation" and "the field was left
 * exactly as it was" produce identical assertions, which is the one thing a
 * translation test has to be able to tell apart.
 */
export class FakeTranslationPort implements TranslationPort {
  private readonly calls: TranslateRequest[] = [];
  private nextFailure: TranslationFailureReason | null = null;

  translate(request: TranslateRequest): Promise<TranslationOutcome> {
    this.calls.push(request);

    if (this.nextFailure !== null) {
      const reason = this.nextFailure;
      this.nextFailure = null;
      return Promise.resolve({ ok: false, reason });
    }

    return Promise.resolve({
      ok: true,
      // Order and keys preserved, because that is precisely the invariant the
      // real gateway can get wrong and that consumers are entitled to rely on.
      translations: request.texts.map((entry) => ({
        key: entry.key,
        text: `[${request.target}] ${entry.text}`,
      })),
    });
  }

  /** Every request the subject sent, in order. */
  get requests(): readonly TranslateRequest[] {
    return this.calls;
  }

  /**
   * Arm ONE failure with a specific reason.
   *
   * Per-call rather than sticky so a test can prove that a retry after a
   * transient vendor failure succeeds — a fake that can only ever succeed
   * leaves every error-mapping path in the module untested.
   */
  failNext(reason: TranslationFailureReason): void {
    this.nextFailure = reason;
  }

  reset(): void {
    this.calls.length = 0;
    this.nextFailure = null;
  }
}
