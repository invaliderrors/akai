import { Injectable, NotFoundException } from "@nestjs/common";
import {
  emailEventSchema,
  type EmailEvent,
  type Paginated,
} from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";
import type { ListEmailEventsQuery } from "./dto/email-admin.dto";

/**
 * Shape of a row as Prisma returns it. Declared explicitly so the mapper below
 * is checked against the SELECT, and adding a column to the query without
 * handling it is a compile error rather than a silently-dropped field.
 */
interface EmailEventRow {
  readonly id: string;
  readonly recipient: string;
  readonly templateKey: string;
  readonly locale: string;
  readonly status: string;
  readonly providerMessageId: string | null;
  readonly orderId: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

export interface SuppressionEntry {
  readonly email: string;
  readonly reason: string;
  readonly createdAt: string;
}

/**
 * Read side of the email admin surface: the operational view over `email_event`
 * that makes a delivery failure diagnosable without a database console.
 *
 * Kept separate from `EmailService` because the two have opposite obligations.
 * `EmailService` must NEVER throw (a mail failure cannot fail a payment);
 * these endpoints MUST throw, because a 404 for a missing event is the correct
 * HTTP answer. Folding both into one class would blur which contract applies.
 */
@Injectable()
export class EmailAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cursor pagination, never OFFSET (contracts/common.ts states the rule).
   * `take: limit + 1` is the standard has-more probe: fetch one extra, report
   * `hasMore` from its presence, and return only `limit` items.
   */
  async list(query: ListEmailEventsQuery): Promise<Paginated<EmailEvent>> {
    const rows: EmailEventRow[] = await this.prisma.emailEvent.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.templateKey === undefined ? {} : { templateKey: query.templateKey }),
        ...(query.recipient === undefined ? {} : { recipient: query.recipient }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined
        ? {}
        : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        id: true,
        recipient: true,
        templateKey: true,
        locale: true,
        status: true,
        providerMessageId: true,
        orderId: true,
        error: true,
        attempts: true,
        sentAt: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => this.toEmailEvent(row)),
      nextCursor: hasMore && last !== undefined ? last.id : null,
      hasMore,
    };
  }

  async get(id: string): Promise<EmailEvent> {
    const row: EmailEventRow | null = await this.prisma.emailEvent.findUnique({
      where: { id },
      select: {
        id: true,
        recipient: true,
        templateKey: true,
        locale: true,
        status: true,
        providerMessageId: true,
        orderId: true,
        error: true,
        attempts: true,
        sentAt: true,
        createdAt: true,
      },
    });

    if (row === null) {
      throw new NotFoundException("Email event not found");
    }
    return this.toEmailEvent(row);
  }

  async listSuppressions(limit: number): Promise<readonly SuppressionEntry[]> {
    const rows = await this.prisma.emailSuppression.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { email: true, reason: true, createdAt: true },
    });

    return rows.map((row) => ({
      email: row.email,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Lift a suppression.
   *
   * A genuine operator action — an address that hard-bounced because the
   * mailbox was full is deliverable again once the customer clears it, and
   * without this the customer silently never receives another order
   * confirmation. Deliberately narrow: there is no endpoint to ADD a
   * suppression, because that is the bounce webhook's job and a manual add
   * would be an undocumented way to blackhole a customer's mail.
   */
  async removeSuppression(email: string): Promise<void> {
    const deleted = await this.prisma.emailSuppression.deleteMany({
      where: { email },
    });

    if (deleted.count === 0) {
      throw new NotFoundException("No suppression exists for that address");
    }
  }

  /**
   * Map a row to the WIRE type, and validate it on the way out.
   *
   * Parsing the response (not just the request) is what catches DB/contract
   * drift at the boundary that notices — a column widened in a migration
   * without updating `emailEventSchema` fails here, in a test, instead of
   * becoming a malformed field in the dashboard.
   */
  private toEmailEvent(row: EmailEventRow): EmailEvent {
    return emailEventSchema.parse({
      id: row.id,
      recipient: row.recipient,
      templateKey: row.templateKey,
      locale: row.locale,
      status: row.status,
      providerMessageId: row.providerMessageId,
      orderId: row.orderId,
      error: row.error,
      attempts: row.attempts,
      sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    });
  }
}
