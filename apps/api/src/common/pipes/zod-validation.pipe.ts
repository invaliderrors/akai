import { Injectable, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/**
 * Parses a request part (body, query, param) through a zod schema.
 *
 * THE canonical validation pipe. Eight near-identical copies of this class were
 * written independently — one per domain module — because each module was built
 * in isolation and none could edit a shared directory. They are all deleted in
 * favour of this file; the surface is identical, so each was a pure import
 * rewrite.
 *
 * WHY NOT THE GLOBAL ValidationPipe: that pipe is class-validator based and
 * reads decorator metadata off a DTO CLASS. Our DTOs are zod schemas (spec §7),
 * which have no class and therefore no metadata for it to read — it passes the
 * body through untouched, silently. A request shape "validated" by a pipe that
 * cannot see it is worse than an unvalidated one, because the code reads as
 * though it is protected. The global ValidationPipe remains for the two
 * non-ts-rest routes that do use classes.
 *
 * `.strict()` on the schemas supplies `forbidNonWhitelisted`: an unknown key is
 * REJECTED, not stripped. Stripping is the more dangerous default — a client
 * that sends `{"role":"ADMIN"}` to a profile endpoint gets a silent 200 and
 * reasonably believes it worked, and the day someone spreads the parsed object
 * into a Prisma `data:` it starts working for real.
 *
 * The thrown ZodError is deliberately NOT caught: AllExceptionsFilter maps it to
 * a 400 VALIDATION_FAILED envelope with per-field paths. Catching and rethrowing
 * an HttpException here would produce a second, differently-shaped response for
 * the same class of failure.
 *
 * INTERIM. When the ts-rest routers land (spec §6), `@ts-rest/nest` validates
 * against the same schemas before the handler runs and this pipe is deleted.
 */
@Injectable()
export class ZodValidationPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  /**
   * Generic over the pipe's OUTPUT, with the schema's INPUT pinned to `unknown`.
   *
   * The obvious spelling — `schema: z.ZodType<TOutput>` — quietly excludes every
   * schema that transforms, and that is most of them. `ZodType<T>` defaults its
   * INPUT parameter to `T`, so a schema with `.default()` (input
   * `{ sort?: string }`, output `{ sort: string }`) or a branded `.transform()`
   * (every money field: input `number`, output `Minor`) fails to assign. Two
   * modules hit exactly this variance error.
   *
   * This class previously dodged that by being generic over the SCHEMA
   * (`TSchema extends z.ZodTypeAny`). It compiled, but `z.ZodTypeAny` is
   * `ZodType<any, any, any>`: `this.schema.parse(value)` evaluated to `any`
   * inside `transform`, so THE pipe whose entire job is to earn a type at
   * runtime was emitting an unchecked `any` into every handler parameter it
   * fed. Declaring the input side as `unknown` states what is actually true —
   * the value came off the wire — and keeps every transforming schema
   * assignable, so the variance problem is solved rather than traded for an
   * `any`.
   *
   * `TOutput` is still inferred from the schema at the call site, so the
   * decorator stays `new ZodValidationPipe(someSchema)` and still proves that
   * the handler's parameter annotation matches what the schema produces.
   */
  constructor(private readonly schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>) {}

  transform(value: unknown): TOutput {
    return this.schema.parse(value);
  }
}
