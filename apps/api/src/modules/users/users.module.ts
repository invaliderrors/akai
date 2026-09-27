import { Module } from "@nestjs/common";
import { AddressesController } from "./addresses.controller";
import { AddressesService } from "./addresses.service";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { CLOCK, systemClock } from "./clock";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { UsersController } from "./users.controller";
import { USERS_REPOSITORY } from "./users.repository";
import { UsersService } from "./users.service";

/**
 * UsersModule — customer accounts, address book, GDPR, admin user administration.
 *
 * `USERS_REPOSITORY` is bound to the Prisma implementation HERE and nowhere
 * else. The services depend on the token, not the class, which is what lets the
 * security tests run the real service logic against an in-memory repository that
 * enforces the same ownership scoping — no database, no mocked methods that can
 * drift from the signatures they stand in for.
 *
 * Authorisation comes from AuthModule's globally registered JwtAuthGuard and
 * RolesGuard (spec §8). The provisional principal/guard/pipe copies this module
 * carried while AuthModule was a placeholder are deleted; the controllers now
 * import the canonical ones.
 */
@Module({
  imports: [PrismaModule],
  controllers: [UsersController, AddressesController, AdminUsersController],
  providers: [
    UsersService,
    AddressesService,
    AdminUsersService,
    { provide: USERS_REPOSITORY, useClass: PrismaUsersRepository },
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [UsersService, AddressesService, AdminUsersService],
})
export class UsersModule {}
