/**
 * @akai/contracts — the shared vocabulary of the platform.
 *
 * Depends on NOTHING but zod (enforced by the Nx `type:contract` boundary tag).
 * That constraint is what lets both browser apps and both server processes
 * import this lib without dragging Prisma, Nest or React into a bundle.
 *
 * Every shape here is a zod schema first and a TypeScript type second
 * (`z.infer`). One declaration therefore yields the validator, the static type
 * and the OpenAPI fragment — they cannot drift, because there is only one of
 * them. Never hand-write an interface that duplicates a schema in this lib.
 *
 * ts-rest routers are added on top of these schemas in a later pass (spec §6);
 * the entity and DTO vocabulary they will reference is complete here. Until
 * then the API validates against these schemas through `ZodValidationPipe` and
 * the clients hand-write fetch wrappers around them — one source of truth
 * either way, which is the property that matters.
 */

export * from "./lib/money";
export * from "./lib/common";
export * from "./lib/enums";
export * from "./lib/inventory";
export * from "./lib/jobs";
export * from "./lib/returns";
export * from "./lib/identity";
export * from "./lib/catalog";
export * from "./lib/commerce";
export * from "./lib/shipping";
export * from "./lib/shipping-admin";
export * from "./lib/destinations";
export * from "./lib/colombia";
export * from "./lib/support";
export * from "./lib/ops";
export * from "./lib/blog";
