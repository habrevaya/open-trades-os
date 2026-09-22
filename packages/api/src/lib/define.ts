import { z } from "zod";

/**
 * ROUTE DEFINITION
 *
 * One definition produces three things that would otherwise drift apart:
 * runtime validation, the TypeScript types, and the OpenAPI document.
 *
 * The documentation cannot go stale because it is not written separately. That
 * matters more here than in most products: the whole pitch is that you own
 * your data, and an API whose docs lie about its shape is not ownership.
 */

export type Method = "get" | "post" | "patch" | "put" | "delete";

export interface RouteDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  /** Module code, so docs and the permission matrix group the same way. */
  module: string;
  /** Every permission the caller must hold. Checked before the handler runs. */
  permissions: readonly string[];
  input: TInput;
  output: TOutput;
  /**
   * Writes take an idempotency key. Not optional on money paths: a retried
   * request must be a no-op, never a second charge.
   */
  idempotent?: boolean;
  /** Excluded from the public OpenAPI document. */
  internal?: boolean;
}

export function defineRoute<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  def: RouteDefinition<TInput, TOutput>,
): RouteDefinition<TInput, TOutput> {
  if (def.method !== "get" && def.permissions.length === 0 && !def.internal) {
    throw new Error(`Write route ${def.method} ${def.path} declares no permissions`);
  }
  return def;
}

export type InputOf<R> = R extends RouteDefinition<infer I, z.ZodTypeAny> ? z.infer<I> : never;
export type OutputOf<R> = R extends RouteDefinition<z.ZodTypeAny, infer O> ? z.infer<O> : never;
