import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Customer } from "@akai/contracts";
import { assertFound } from "@akai/db";
import { CLOCK, type Clock } from "./clock";
import {
  erasureResultSchema,
  personalDataExportSchema,
  type ErasureRequestInput,
  type ErasureResult,
  type PersonalDataExport,
  type UpdateProfileInput,
} from "./dto/users.dto";
import { toCustomer } from "./users.mapper";
import {
  USERS_REPOSITORY,
  type CustomerRow,
  type ProfilePatch,
  type UsersRepository,
} from "./users.repository";

/**
 * Customer self-service: profile, GDPR portability, erasure.
 *
 * EVERY method takes `customerId` as its first parameter and it is supplied
 * only by `@CurrentUser()`. No method accepts an id from a path, query or body.
 * That is the module's IDOR defence stated as a signature convention: there is
 * no overload that could read someone else's profile, so a controller cannot
 * write one by accident.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly repository: UsersRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getProfile(customerId: string): Promise<Customer> {
    return toCustomer(await this.requireCustomer(customerId));
  }

  async updateProfile(
    customerId: string,
    input: UpdateProfileInput,
  ): Promise<Customer> {
    const existing = await this.requireCustomer(customerId);
    this.assertNotAnonymised(existing);

    // Built explicitly rather than passed through. A spread of the parsed body
    // would carry whatever the schema happens to allow TODAY into the update,
    // so widening the DTO later would silently widen what is writable.
    const patch: ProfilePatch = {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.preferredLocale !== undefined
        ? { preferredLocale: input.preferredLocale }
        : {}),
    };

    // An empty PATCH is a no-op, not an error, but there is no reason to spend a
    // write and an `updatedAt` bump on it.
    if (Object.keys(patch).length === 0) {
      return toCustomer(existing);
    }

    return toCustomer(await this.repository.updateCustomerProfile(customerId, patch));
  }

  /**
   * GDPR Art. 20 portability export.
   *
   * Assembled synchronously today. Spec §5 puts this on the `gdpr-export` queue
   * with a signed download URL, and it should move there once QueueModule is
   * real — a customer with thousands of orders will otherwise hold a request
   * open long enough to trip a gateway timeout. The assembly logic below is
   * already the unit of work the worker will call, so that move is a
   * relocation rather than a rewrite (see followUps).
   */
  async exportPersonalData(customerId: string): Promise<PersonalDataExport> {
    const customer = await this.requireCustomer(customerId);

    // Scoped by the OWNER's id and the owner's email — never by an address the
    // caller supplied, which would turn the export endpoint into a way to read
    // anyone's mail history by guessing their address.
    const [addresses, orders, consents, emails, sessions] = await Promise.all([
      this.repository.listAddresses(customerId),
      this.repository.listOrdersForExport(customerId),
      this.repository.listConsentRecords(customerId),
      this.repository.listEmailEvents(customer.email),
      this.repository.listSessions(customerId),
    ]);

    return personalDataExportSchema.parse({
      generatedAt: this.clock.now().toISOString(),
      formatVersion: 1,
      profile: toCustomer(customer),
      addresses: addresses.map((address) => ({
        id: address.id,
        customerId: address.customerId,
        type: address.type,
        firstName: address.firstName,
        lastName: address.lastName,
        company: address.company,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        region: address.region,
        postalCode: address.postalCode,
        countryCode: address.countryCode,
        phone: address.phone,
        isDefault: address.isDefault,
        createdAt: address.createdAt.toISOString(),
        updatedAt: address.updatedAt.toISOString(),
      })),
      orders: orders.map((order) => ({
        orderNumber: order.orderNumber,
        status: order.status,
        currency: order.currency,
        grandTotal: order.grandTotal,
        placedAt: order.placedAt.toISOString(),
        invoiceNumber: order.invoiceNumber,
      })),
      consents: consents.map((consent) => ({
        kind: consent.kind,
        version: consent.version,
        granted: consent.granted,
        recordedAt: consent.createdAt.toISOString(),
      })),
      emails: emails.map((email) => ({
        templateKey: email.templateKey,
        status: email.status,
        sentAt: email.sentAt?.toISOString() ?? null,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })),
    });
  }

  /**
   * GDPR Art. 17 erasure — anonymise in place, never DELETE.
   *
   * A hard delete would cascade the customer row away and take the financial
   * record with it (or orphan it, since Order.customerId is ON DELETE SET NULL),
   * and EU invoice retention of 7-10 years is a legal OBLIGATION that Art.
   * 17(3)(b) explicitly exempts from erasure. So the person is tombstoned and
   * the money is kept: identifying columns are cleared, the email is replaced
   * with a unique non-routable value, and the order rows — which snapshot their
   * own addresses by design (spec §13) — survive untouched.
   */
  async requestErasure(
    customerId: string,
    input: ErasureRequestInput,
  ): Promise<ErasureResult> {
    const customer = await this.requireCustomer(customerId);

    // IDEMPOTENT. A retried request must not 500 or double-write; erasure is
    // exactly the operation a nervous user clicks twice.
    if (customer.anonymisedAt !== null) {
      const [ordersRetained] = await Promise.all([
        this.repository.countOrders(customerId),
      ]);
      return erasureResultSchema.parse({
        anonymisedAt: customer.anonymisedAt.toISOString(),
        ordersRetained,
        addressesErased: 0,
        sessionsRevoked: 0,
      });
    }

    // Compared against the STORED email, not the submitted one echoed back.
    // Both are lower-cased — the DTO's emailSchema transforms on parse and the
    // column is citext — so this is a like-for-like comparison, not a
    // case-sensitive trap that would reject a legitimate confirmation.
    if (input.confirmEmail !== customer.email.toLowerCase()) {
      throw new BadRequestException(
        "Confirmation email does not match the account email",
      );
    }

    // Refuse while a contract is still being performed. Anonymising a customer
    // whose parcel is in transit destroys the delivery address on the account
    // and the ability to contact them about it, and the retention basis for
    // that data is contract performance, not consent.
    const openOrders = await this.repository.countOpenOrders(customerId);
    if (openOrders > 0) {
      throw new ConflictException(
        "Account cannot be erased while orders are still being fulfilled",
      );
    }

    const now = this.clock.now();

    return this.repository.transaction(async (tx) => {
      const anonymised = await tx.anonymiseCustomer(
        customerId,
        tombstoneEmail(customerId),
        now,
      );

      // Order matters less than atomicity here, but revoking credentials inside
      // the same transaction is the point: a tombstoned profile whose sessions
      // still authenticate is strictly worse than no erasure at all, because the
      // account is now unrecoverable AND still reachable.
      const [addressesErased, sessionsRevoked, ordersRetained] = await Promise.all([
        tx.softDeleteAllAddresses(customerId),
        tx.revokeAllSessions(customerId, now),
        tx.countOrders(customerId),
      ]);
      await tx.revokeAllRefreshTokens(customerId, now);
      await tx.deleteRecoveryCodes(customerId);

      return erasureResultSchema.parse({
        anonymisedAt: anonymised.anonymisedAt?.toISOString() ?? now.toISOString(),
        ordersRetained,
        addressesErased,
        sessionsRevoked,
      });
    });
  }

  private async requireCustomer(customerId: string): Promise<CustomerRow> {
    return assertFound(await this.repository.findCustomerById(customerId), "Customer");
  }

  /**
   * A closed account is read-only.
   *
   * Without this, a session issued before erasure could keep writing to the
   * tombstone — repopulating the name and phone number that were just cleared.
   */
  private assertNotAnonymised(customer: CustomerRow): void {
    if (customer.anonymisedAt !== null) {
      throw new ConflictException("This account has been closed and cannot be modified");
    }
  }
}

/**
 * The tombstone address.
 *
 * Derived from the customer id so it is deterministic (a retry produces the same
 * value rather than a second unique row) and unique (the email column has a
 * UNIQUE constraint, so a shared placeholder would make the SECOND erasure fail).
 * `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve, so the
 * address cannot accidentally be mailed.
 */
export function tombstoneEmail(customerId: string): string {
  return `anonymised-${customerId}@akai.invalid`;
}
