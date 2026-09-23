import { z } from "zod";

/**
 * ZOD TO JSON SCHEMA
 *
 * The contracts are the only description of this API's shapes, and two
 * consumers need them as JSON Schema: the OpenAPI document and the MCP
 * tool list. Written here rather than pulled from a package because the
 * conversion this product needs is narrow and the mistakes it must not make
 * are specific.
 *
 * THE MISTAKE THAT MATTERS MOST. `MoneyString` is a string on purpose, and
 * `common.ts` explains at length why: a JSON number is an IEEE 754 double,
 * and 0.1 does not survive a round trip. A converter that looks at a decimal
 * regex and decides it means `number` puts a float money bug into every
 * generated client and every agent that reads the tool schema, and it does it
 * silently, in a layer nobody reads. Nothing here infers a type from a
 * pattern. A zod string becomes a JSON Schema string, always.
 *
 * Draft 2020-12, which is what OpenAPI 3.1 and MCP both use, so one output
 * serves both without a dialect translation in between.
 */

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  pattern?: string;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
}

/**
 * What a zod type is, without `instanceof`.
 *
 * `instanceof ZodString` fails when two copies of zod are resolved in one
 * process, which happens the first time a workspace package and an app pull
 * different patch versions. The failure is not an error: every check returns
 * false and every field silently becomes `{}`, so the document generates,
 * the tool list generates, and both describe an API with no fields at all.
 * The type name is on the definition and does not care which copy made it.
 */
const kindOf = (schema: z.ZodTypeAny): string =>
  (schema._def as { typeName?: string }).typeName ?? "";

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as Record<string, unknown>;
  const description = schema.description;
  const withDescription = (out: JsonSchema): JsonSchema =>
    description ? { ...out, description } : out;

  switch (kindOf(schema)) {
    case "ZodString": return withDescription(stringSchema(schema as z.ZodString));
    case "ZodNumber": return withDescription(numberSchema(schema as z.ZodNumber));
    case "ZodBigInt": return withDescription({ type: "integer" });
    case "ZodBoolean": return withDescription({ type: "boolean" });

    /**
     * A date is a string on the wire, and the conversion says so.
     *
     * `z.date()` describes what the value is after parsing, not what a caller
     * sends. Emitting `{ type: "object" }` here, which is what a structural
     * converter does, tells an agent to send `{}` where an ISO instant
     * belongs.
     */
    case "ZodDate": return withDescription({ type: "string", format: "date-time" });

    case "ZodLiteral": {
      const jsonType = jsonTypeOf(def.value);
      return withDescription({
        const: def.value,
        ...(jsonType ? { type: jsonType } : {}),
      });
    }

    case "ZodEnum":
      return withDescription({ type: "string", enum: [...(def.values as string[])] });

    case "ZodNativeEnum":
      return withDescription({ enum: Object.values(def.values as Record<string, unknown>) });

    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: toJsonSchema(def.type as z.ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return withDescription(out);
    }

    case "ZodObject": return withDescription(objectSchema(schema as z.ZodObject<z.ZodRawShape>));

    case "ZodRecord":
      return withDescription({
        type: "object",
        additionalProperties: toJsonSchema(def.valueType as z.ZodTypeAny),
      });

    /**
     * Optional and default both unwrap, and NEITHER changes the inner schema.
     *
     * Whether a field is required is a property of the object that contains
     * it, decided in `objectSchema`, because that is where JSON Schema puts
     * it. A converter that marks optionality on the field itself produces a
     * document where nothing is ever required.
     */
    case "ZodOptional": return toJsonSchema(def.innerType as z.ZodTypeAny);

    case "ZodDefault": {
      const inner = toJsonSchema(def.innerType as z.ZodTypeAny);
      const value = (def.defaultValue as () => unknown)();
      return { ...inner, default: value };
    }

    case "ZodNullable": {
      const inner = toJsonSchema(def.innerType as z.ZodTypeAny);
      return { anyOf: [inner, { type: "null" }] };
    }

    case "ZodUnion":
      return withDescription({
        anyOf: (def.options as z.ZodTypeAny[]).map(toJsonSchema),
      });

    case "ZodDiscriminatedUnion":
      return withDescription({
        anyOf: [...(def.options as z.ZodTypeAny[])].map(toJsonSchema),
      });

    case "ZodIntersection":
      /**
       * Merged rather than emitted as `allOf`.
       *
       * An MCP client feeds the tool schema to a model, and a model handed
       * `allOf` of two objects reliably sends one of them. The merge loses
       * nothing here because the contracts only intersect object schemas.
       */
      return withDescription(mergeObjects(
        toJsonSchema(def.left as z.ZodTypeAny),
        toJsonSchema(def.right as z.ZodTypeAny),
      ));

    /** A refinement or transform narrows what is accepted; the shape is the inner one. */
    case "ZodEffects": return toJsonSchema(def.schema as z.ZodTypeAny);
    case "ZodPipeline": return toJsonSchema(def.in as z.ZodTypeAny);
    case "ZodBranded": case "ZodReadonly": return toJsonSchema(def.type as z.ZodTypeAny);
    case "ZodLazy": return toJsonSchema((def.getter as () => z.ZodTypeAny)());

    case "ZodTuple":
      return withDescription({
        type: "array",
        items: { anyOf: (def.items as z.ZodTypeAny[]).map(toJsonSchema) },
        minItems: (def.items as z.ZodTypeAny[]).length,
      });

    case "ZodNull": return { type: "null" };
    case "ZodAny": case "ZodUnknown": return {};

    default:
      /**
       * Loud rather than empty.
       *
       * An unhandled zod type silently becoming `{}` is the worst outcome
       * available: the document still generates, the tool list still
       * generates, and the field it describes accepts anything. This throws
       * at build time, where somebody is reading the output.
       */
      throw new Error(
        `No JSON Schema conversion for ${kindOf(schema) || "an unrecognised zod type"}. ` +
        `Add it to packages/api/src/lib/json-schema.ts rather than letting the field disappear.`,
      );
  }
}

function jsonTypeOf(value: unknown): string | undefined {
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return undefined;
  }
}

function stringSchema(schema: z.ZodString): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "uuid": out.format = "uuid"; break;
      case "email": out.format = "email"; break;
      case "url": out.format = "uri"; break;
      case "datetime": out.format = "date-time"; break;
      case "min": out.minLength = check.value; break;
      case "max": out.maxLength = check.value; break;
      case "length": out.minLength = check.value; out.maxLength = check.value; break;
      /**
       * The pattern is carried, and the type stays `string`.
       *
       * This is the MoneyString case. The regex looks numeric and it is not a
       * licence to emit `{ type: "number" }`; see the header.
       */
      case "regex": out.pattern = check.regex.source; break;
      default: break;
    }
  }
  return out;
}

function numberSchema(schema: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "int": out.type = "integer"; break;
      case "min": out.minimum = check.value; break;
      case "max": out.maximum = check.value; break;
      default: break;
    }
  }
  return out;
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    properties[key] = toJsonSchema(field);

    /**
     * A field with a default is NOT required, and this is where a generated
     * client stops working.
     *
     * `limit: z.number().default(50)` is satisfied by sending nothing. Marking
     * it required makes every list call fail validation in a client that
     * trusted the schema, and makes a model fill in a page size it was never
     * asked to choose.
     */
    if (!field.isOptional()) required.push(key);
  }

  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;

  /**
   * Closed by default, because the contracts are.
   *
   * zod strips unknown keys rather than rejecting them, so a caller sending
   * an extra field gets a success and a silently discarded value. Saying
   * `additionalProperties: false` in the schema is what lets a client or a
   * model find that out before the call rather than after.
   */
  out.additionalProperties = false;
  return out;
}

function mergeObjects(left: JsonSchema, right: JsonSchema): JsonSchema {
  if (left.type !== "object" || right.type !== "object") {
    return { anyOf: [left, right] };
  }
  return {
    type: "object",
    properties: { ...left.properties, ...right.properties },
    ...(left.required || right.required
      ? { required: [...new Set([...(left.required ?? []), ...(right.required ?? [])])] }
      : {}),
    additionalProperties: false,
  };
}
