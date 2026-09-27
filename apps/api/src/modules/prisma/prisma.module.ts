import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/**
 * Global: nearly every domain module needs database access, and importing
 * PrismaModule in each of them is ceremony that adds no safety.
 *
 * The boundary that matters is not module-to-module inside the API — it is
 * server-to-browser, and that one is enforced by the Nx `scope:server` tag on
 * @akai/db, which makes a Next app importing Prisma a lint error.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
