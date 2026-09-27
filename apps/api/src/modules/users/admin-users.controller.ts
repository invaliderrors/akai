import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AdminCustomer, Paginated } from "@akai/contracts";
import { AdminUsersService } from "./admin-users.service";
import { adminUserListQuerySchema, type AdminUserListQuery } from "./dto/users.dto";
import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

/**
 * Admin/staff customer administration.
 *
 * `@Roles` sits at CLASS level, not on individual methods. That is the whole
 * point: a method added to this controller next month inherits the restriction
 * automatically, whereas per-method decorators make an unprotected endpoint
 * exactly one forgotten line away.
 *
 * There is no `@UseGuards` here. JwtAuthGuard and RolesGuard are registered
 * globally as APP_GUARD in AppModule (spec §8, deny-by-default), so a route
 * without `@Public()` is already authenticated and a class with `@Roles` is
 * already authorised. Re-declaring the guard locally would run it twice and,
 * worse, imply that a controller WITHOUT the declaration is unguarded.
 *
 * Reaching any route here as a CUSTOMER is a 403, proven in
 * admin-users.controller.test.ts against every route this class declares — the
 * test enumerates them by reflection rather than by a hand-maintained list, so a
 * new route cannot escape the assertion.
 */
@ApiTags("admin")
@Controller("admin/users")
@Roles("STAFF", "ADMIN")
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: "List customers with cursor pagination and filters" })
  async list(
    @Query(new ZodValidationPipe(adminUserListQuerySchema)) query: AdminUserListQuery,
  ): Promise<Paginated<AdminCustomer>> {
    return this.adminUsers.list(query);
  }

  @Get(":customerId")
  @ApiOperation({ summary: "Read a single customer's admin view" })
  async get(
    @Param("customerId", ParseUUIDPipe) customerId: string,
  ): Promise<AdminCustomer> {
    return this.adminUsers.get(customerId);
  }
}
