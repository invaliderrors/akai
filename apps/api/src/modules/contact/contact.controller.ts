import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  contactRequestSchema,
  type ContactRequest,
  type ContactResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { extractClientIp } from "../auth/guards/rate-limit.guard";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { ContactService } from "./contact.service";

/**
 * The contact form. One route, and it is the most abusable shape on the API:
 * an anonymous HTTP request that produces outbound email.
 *
 * THREE layers guard it, none of which is sufficient alone:
 *  1. `ThrottleGuard` on the tightest bucket in the platform (5 per 15 minutes
 *     per client) — durable and shared across replicas, unlike the storefront's
 *     old in-memory limiter whose own comment admitted it was per-instance.
 *  2. Turnstile verification inside `ContactService`, honouring an explicit
 *     rejection while failing open on a Cloudflare outage.
 *  3. A `.strict()` schema with a 5000-character ceiling, so the body cannot be
 *     used to relay a payload of arbitrary size.
 *
 * The WordPress endpoint it replaces had none of the three.
 */
@ApiTags("contact")
@Controller("contact")
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  /**
   * 202 ACCEPTED, not 200 OK — and the distinction is honest rather than
   * pedantic. The submission is durably queued when this returns; it has not
   * been delivered, and it deliberately does not wait to find out. Reporting a
   * transport failure to the submitter would invite them to resubmit into a
   * problem only we can fix, and would leak which addresses our provider
   * rejects.
   *
   * The request object is read for ONE thing: the client IP, which Turnstile's
   * siteverify accepts as corroborating evidence. It is not passed to the
   * service as a request — the service takes a `string | null`, so no handler
   * downstream can reach for a header nobody audited.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.contact)
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Submit the contact form" })
  async submit(
    @Body(new ZodValidationPipe(contactRequestSchema)) body: ContactRequest,
    @Req() request: unknown,
  ): Promise<ContactResponse> {
    return this.contact.submit(body, extractClientIp(request));
  }
}
