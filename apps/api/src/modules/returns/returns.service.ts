import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  canTransitionReturn,
  isReturnOpen,
  returnStatusSchema,
  RETURN_TRANSITIONS,
  type CreateReturnRequest,
  type ListReturnsQuery,
  type Paginated,
  type ReturnRequest,
  type ReturnStatus,
  type UpdateReturnRequest,
} from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Return requests.
 *
 * TWO RULES THAT ARE NOT OBVIOUS FROM THE SHAPE:
 *
 * 1. IT NEVER MOVES MONEY. `REFUNDED` here records that a refund happened; it
 *    does not cause one. Refunding is `POST /v1/admin/orders/:orderNumber/refunds`,
 *    which calls the payment provider under an idempotency key. Chaining an
 *    irreversible transfer to a status dropdown is how a mis-click becomes a
 *    bank movement.
 *
 * 2. IT EMITS NO OUTBOX EVENT. A `returns.requested` topic with no registered
 *    handler does not sit harmlessly waiting for one — the dispatcher treats an
 *    unrouted topic as a failure, so every request would burn its retry budget
 *    and dead-letter, and `/admin/jobs` would fill with red. A topic gets emitted
 *    in the same change as its consumer or not at all.
 */

/** Only a delivered order may be returned; earlier states have their own remedies. */
const RETURNABLE_ORDER_STATUSES: readonly string[] = ["DELIVERED"];

type ReturnPrismaClient = Pick<PrismaService, "returnRequest" | "order" | "$transaction">;

interface ReturnRow {
  id: string;
  orderId: string;
  status: string;
  reason: string;
  adminNote: string | null;
  returnLabelUrl: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
  order: { orderNumber: string };
}

const ROW_SELECT = {
  id: true,
  orderId: true,
  status: true,
  reason: true,
  adminNote: true,
  returnLabelUrl: true,
  requestedAt: true,
  resolvedAt: true,
  order: { select: { orderNumber: true } },
} as const;

@Injectable()
export class ReturnsService {
  constructor(@Inject(PrismaService) private readonly prisma: ReturnPrismaClient) {}

  /**
   * Raises a request against one of the CALLER'S OWN orders.
   *
   * Ownership is part of the lookup, not a check after it: querying by
   * `{ orderNumber, customerId }` means another customer's order is simply not
   * found, and the 404 does not confirm that the number exists.
   */
  async request(customerId: string, input: CreateReturnRequest): Promise<ReturnRequest> {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber: input.orderNumber, customerId },
      select: { id: true, status: true, orderNumber: true },
    });

    if (order === null) {
      throw new NotFoundException("Order not found");
    }

    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Only a delivered order can be returned",
      });
    }

    // One OPEN request per order. A second one would give an operator two
    // decisions to make about the same parcel, and nothing says which wins.
    const existing = await this.prisma.returnRequest.findFirst({
      where: { orderId: order.id },
      select: { status: true },
    });

    if (existing !== null && isReturnOpen(returnStatusSchema.parse(existing.status))) {
      throw new ConflictException({
        code: "CONFLICT",
        message: "A return is already open for this order",
      });
    }

    const created = await this.prisma.returnRequest.create({
      data: {
        orderId: order.id,
        customerId,
        reason: input.reason,
      },
      select: ROW_SELECT,
    });

    return toReturnRequest(created);
  }

  /** The caller's own requests, newest first. */
  async listForCustomer(
    customerId: string,
    query: ListReturnsQuery,
  ): Promise<Paginated<ReturnRequest>> {
    return this.page({ customerId, ...statusFilter(query.status) }, query);
  }

  /** Every request, for an operator. */
  async listForAdmin(query: ListReturnsQuery): Promise<Paginated<ReturnRequest>> {
    return this.page(statusFilter(query.status), query);
  }

  /**
   * Moves a request along its state machine.
   *
   * The transition is validated against a CLOSED map. Without it an operator
   * could walk a REJECTED request to REFUNDED and issue money against a decision
   * that was never approved.
   */
  async update(id: string, input: UpdateReturnRequest): Promise<ReturnRequest> {
    const existing = await this.prisma.returnRequest.findUnique({
      where: { id },
      select: { status: true },
    });

    if (existing === null) {
      throw new NotFoundException("Return request not found");
    }

    // PARSED, not cast: the column is a Postgres enum, but a row written by an
    // older deploy or by hand must not reach the state machine unvalidated.
    const from = returnStatusSchema.parse(existing.status);
    if (from !== input.status && !canTransitionReturn(from, input.status)) {
      const allowed = RETURN_TRANSITIONS[from];
      throw new ConflictException({
        code: "ILLEGAL_STATE_TRANSITION",
        message:
          allowed.length === 0
            ? `A ${from} return is final and cannot be changed`
            : `A ${from} return can only become ${allowed.join(" or ")}`,
      });
    }

    const updated = await this.prisma.returnRequest.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.adminNote === undefined ? {} : { adminNote: input.adminNote }),
        ...(input.returnLabelUrl === undefined ? {} : { returnLabelUrl: input.returnLabelUrl }),
        // Stamped when the request stops being open, cleared never: a resolved
        // date that moves as an operator edits a note would misreport when the
        // decision was actually made.
        ...(isReturnOpen(input.status) ? {} : { resolvedAt: new Date() }),
      },
      select: ROW_SELECT,
    });

    return toReturnRequest(updated);
  }

  private async page(
    where: Prisma.ReturnRequestWhereInput,
    query: ListReturnsQuery,
  ): Promise<Paginated<ReturnRequest>> {
    const rows = await this.prisma.returnRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: ROW_SELECT,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toReturnRequest),
      hasMore,
      nextCursor: hasMore && last !== undefined ? last.id : null,
    };
  }
}

function statusFilter(status: ReturnStatus | undefined): Prisma.ReturnRequestWhereInput {
  return status === undefined ? {} : { status };
}

function toReturnRequest(row: ReturnRow): ReturnRequest {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    // Narrowed through the enum rather than asserted, for the same reason.
    status: returnStatusSchema.parse(row.status),
    reason: row.reason,
    adminNote: row.adminNote,
    returnLabelUrl: row.returnLabelUrl,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}
