import type {
  EmailTransport,
  RenderedMessage,
  TransportLogger,
  TransportResult,
} from "../email.port";

/**
 * Local-development transport.
 *
 * Spec §10 specifies a Nodemailer→Mailpit adapter for dev and test. `nodemailer`
 * is not yet a workspace dependency and adding one to the shared root
 * package.json would collide with the agents working in parallel, so this
 * stands in: same seam, same interface, no network, no silent success against a
 * real inbox. Swapping it for the SMTP adapter is a one-file change plus a
 * provider-factory branch — see followUps.
 *
 * It logs the SUBJECT and recipient, never the body. Bodies contain reset links
 * and order contents, and a dev log routinely gets pasted into an issue.
 */
export class LoggingTransport implements EmailTransport {
  readonly name = "logging";

  private counter = 0;

  constructor(private readonly logger: TransportLogger) {}

  async send(message: RenderedMessage): Promise<TransportResult> {
    this.counter += 1;
    const providerMessageId = `local-${String(this.counter).padStart(6, "0")}`;

    this.logger.info(
      {
        // `email` is in the logger's REDACT_PATHS, so the recipient is redacted
        // by the logger itself rather than by remembering to omit it here.
        email: message.to,
        subject: message.subject,
        tags: message.tags,
        providerMessageId,
        transport: this.name,
      },
      "Email dispatched via local transport (not actually delivered)",
    );

    return { providerMessageId };
  }
}
