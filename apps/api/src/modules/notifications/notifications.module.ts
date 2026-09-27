import { Module } from "@nestjs/common";

/**
 * NotificationsModule — PLACEHOLDER.
 *
 * OWNS: In-app and admin notifications, distinct from transactional email.
 *
 * Empty but importable, so AppModule's composition is complete and reviewable
 * from day one and later agents add controllers/providers here rather than
 * inventing a parallel structure. Filled in one module per commit (spec R6).
 */
@Module({})
export class NotificationsModule {}
