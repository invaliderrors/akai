import { Injectable } from "@nestjs/common";
import type { EmailPort, SendEmailInput, SendEmailResult } from "@akai/contracts";
import { EmailService } from "./email.service";

/**
 * Adapts `EmailService` to the @akai/contracts `EmailPort` interface.
 *
 * A separate class, not `EmailService implements EmailPort`, because the two
 * `send` signatures genuinely differ and SHOULD: the port's is untyped-by-design
 * (`data: Record<string, unknown>`) so the contract stays free of the template
 * vocabulary, while the service's is generic so a wrong payload is a compile
 * error. Forcing one class to satisfy both would mean widening the service's
 * signature to the port's — throwing away the type safety that is the whole
 * point of this module.
 *
 * Bind this token in a consumer that only wants the interface; its test then
 * substitutes `FakeEmailPort` from @akai/testing with no other change.
 */
export const EMAIL_PORT = Symbol("EMAIL_PORT");

@Injectable()
export class EmailPortAdapter implements EmailPort {
  constructor(private readonly emails: EmailService) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return this.emails.sendViaPort(input);
  }
}
