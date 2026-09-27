import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { EmailEvent, Paginated } from "@akai/contracts";
import {
  emailEventIdParamSchema,
  listEmailEventsQuerySchema,
  retryEmailBodySchema,
  suppressionEmailParamSchema,
  type EmailEventIdParam,
  type ListEmailEventsQuery,
  type RetryEmailBody,
  type SuppressionEmailParam,
} from "./dto/email-admin.dto";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { EmailAdminService, type SuppressionEntry } from "./email-admin.service";
import { Roles } from "../auth/guards/roles.guard";
import type { EmailDispatchResult } from "./email.service";
import { EmailService } from "./email.service";

/**
 * ADMIN-ONLY. There is deliberately NO customer-facing email endpoint.
 *
 * Nothing here lets a caller compose or trigger an arbitrary email. Every send
 * in the platform originates from a domain event (order paid, shipment created,
 * password reset requested) inside the owning module — because an endpoint that
 * accepts a recipient and a body is an open relay wearing an auth check, and
 * one leaked staff session turns the platform's sending domain into a phishing
 * origin. `retry` is the only write, and it can only re-send a template that
 * was already legitimately generated, to the address already on the row.
 *
 * `@Roles` is applied at the CLASS level, so a handler added later inherits the
 * policy rather than defaulting to open. Authentication and role enforcement
 * come from the globally registered JwtAuthGuard + RolesGuard (spec §8); this
 * module no longer carries its own copy of either.
 */
@ApiTags("admin/emails")
@Controller("admin/emails")
@Roles("STAFF", "ADMIN")
export class EmailController {
  constructor(
    private readonly admin: EmailAdminService,
    private readonly emails: EmailService,
  ) {}

  /**
   * ROUTE ORDER IS LOAD-BEARING: this must be declared before `:id`, or Express
   * matches "suppressions" as an id and the uuid pipe rejects it with a
   * confusing 400. Declaration order is the only thing that resolves it.
   */
  @Get("suppressions")
  @ApiOperation({ summary: "Addresses suppressed after a hard bounce or complaint" })
  async listSuppressions(): Promise<readonly SuppressionEntry[]> {
    return this.admin.listSuppressions(100);
  }

  @Delete("suppressions/:email")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Lift a suppression so the address can receive mail again" })
  async removeSuppression(
    @Param(new ZodValidationPipe(suppressionEmailParamSchema))
    params: SuppressionEmailParam,
  ): Promise<void> {
    await this.admin.removeSuppression(params.email);
  }

  @Get()
  @ApiOperation({ summary: "List transactional email events (cursor-paginated)" })
  async list(
    @Query(new ZodValidationPipe(listEmailEventsQuerySchema))
    query: ListEmailEventsQuery,
  ): Promise<Paginated<EmailEvent>> {
    return this.admin.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "One email event, including its failure reason" })
  async get(
    @Param(new ZodValidationPipe(emailEventIdParamSchema)) params: EmailEventIdParam,
  ): Promise<EmailEvent> {
    return this.admin.get(params.id);
  }

  /**
   * ADMIN ONLY — narrower than the rest of the controller.
   *
   * Reading the delivery log is a support task; re-sending mail to a customer
   * is a privileged action with an external side effect that cannot be undone.
   * The method-level decorator overrides the class-level one (the guard uses
   * `getAllAndOverride`, handler first), so STAFF can diagnose but only ADMIN
   * can act.
   */
  @Post(":id/retry")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Re-attempt a failed send. Refuses if already delivered." })
  async retry(
    @Param(new ZodValidationPipe(emailEventIdParamSchema)) params: EmailEventIdParam,
    @Body(new ZodValidationPipe(retryEmailBodySchema)) body: RetryEmailBody,
  ): Promise<EmailDispatchResult> {
    return this.emails.retryFailed(params.id, body.payload);
  }
}
