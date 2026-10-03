/**
 * THE SCHEMA A MODEL IS SHOWN IS THE SCHEMA ITS ANSWER IS HELD TO
 *
 * Every action an agent can take is offered to the model as a tool with a
 * JSON Schema, and the model's answer comes back as an object that claims to
 * fit it. Nothing guarantees that. A model fills a field it was told is a
 * number with "about two", invents a third window when it was allowed two,
 * and writes a paragraph into a field capped at a sentence.
 *
 * So the same object that is sent to the vendor is the one the answer is
 * checked against here, rather than a second description written for the
 * check. Two descriptions of one shape agree on the day they are written and
 * drift from then on, and the drift is silent in exactly the direction that
 * matters: a model told a field is optional, held to a check that thinks it
 * is required, or the other way round.
 *
 * A SUBSET OF JSON SCHEMA, ON PURPOSE. The keywords below are the ones the
 * action catalogue uses. A keyword this does not understand is refused when
 * the catalogue is built (see `assertSupported`), because a check that
 * silently ignored `pattern` would pass a date it was meant to refuse.
 *
 * UNKNOWN KEYS ARE DROPPED, NOT REFUSED. Models add helpful extra fields.
 * Refusing a whole booking draft because the model also wrote "notes" is a
 * failure an operator can do nothing about, and dropping it is safe because
 * nothing downstream reads a key the schema does not declare: the value
 * returned is built from the declared properties only.
 */

export type JsonSchema = Record<string, unknown>;

export type Checked =
  | { ok: true; value: unknown }
  | { ok: false; path: string; reason: string };

const SUPPORTED = new Set([
  "type", "description", "properties", "required", "additionalProperties", "items",
  "enum", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "minItems", "maxItems", "pattern",
]);

/**
 * Refuse a schema using a keyword the checker would ignore.
 *
 * Called by the catalogue's own test over every action, so a keyword added to
 * a tool's schema without teaching the checker about it fails a build rather
 * than a booking.
 */
export function unsupportedKeywords(schema: JsonSchema, path = "$"): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED.has(key)) found.push(`${path}.${key}`);
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        found.push(...unsupportedKeywords(child as JsonSchema, `${path}.${name}`));
      }
    }
    if (key === "items" && value && typeof value === "object") {
      found.push(...unsupportedKeywords(value as JsonSchema, `${path}[]`));
    }
  }
  return found;
}

const fail = (path: string, reason: string): Checked => ({ ok: false, path, reason });

/** Check a value against a schema, and return the value rebuilt from what the schema declares. */
export function check(schema: JsonSchema, value: unknown, path = "$"): Checked {
  const type = schema["type"];

  if (Array.isArray(schema["enum"])) {
    if (!(schema["enum"] as unknown[]).includes(value)) {
      return fail(path, `must be one of ${(schema["enum"] as unknown[]).join(", ")}`);
    }
    return { ok: true, value };
  }

  switch (type) {
    case "string": {
      if (typeof value !== "string") return fail(path, "must be text");
      const text = value.trim();
      const min = schema["minLength"];
      const max = schema["maxLength"];
      if (typeof min === "number" && text.length < min) return fail(path, min === 1 ? "is empty" : `is shorter than ${min} characters`);
      if (typeof max === "number" && text.length > max) return fail(path, `is longer than ${max} characters`);
      const pattern = schema["pattern"];
      if (typeof pattern === "string" && !new RegExp(pattern).test(text)) return fail(path, "is not in the expected form");
      return { ok: true, value: text };
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "must be a number");
      if (type === "integer" && !Number.isInteger(value)) return fail(path, "must be a whole number");
      const minimum = schema["minimum"];
      const maximum = schema["maximum"];
      const above = schema["exclusiveMinimum"];
      if (typeof minimum === "number" && value < minimum) return fail(path, `must be at least ${minimum}`);
      if (typeof above === "number" && value <= above) return fail(path, `must be more than ${above}`);
      if (typeof maximum === "number" && value > maximum) return fail(path, `must be at most ${maximum}`);
      return { ok: true, value };
    }
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : fail(path, "must be true or false");
    case "array": {
      if (!Array.isArray(value)) return fail(path, "must be a list");
      const min = schema["minItems"];
      const max = schema["maxItems"];
      if (typeof min === "number" && value.length < min) return fail(path, `needs at least ${min}`);
      if (typeof max === "number" && value.length > max) return fail(path, `allows at most ${max}`);
      const items = schema["items"] as JsonSchema | undefined;
      if (!items) return { ok: true, value: [...value] };
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = check(items, value[i], `${path}[${i}]`);
        if (!item.ok) return item;
        out.push(item.value);
      }
      return { ok: true, value: out };
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(path, "must be an object");
      const record = value as Record<string, unknown>;
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      const required = (schema["required"] ?? []) as string[];
      const out: Record<string, unknown> = {};
      for (const name of required) {
        if (record[name] === undefined || record[name] === null) return fail(`${path}.${name}`, "is missing");
      }
      for (const [name, child] of Object.entries(properties)) {
        const raw = record[name];
        /**
         * Null on an optional field is read as absent. Models write null for
         * "not known" far more often than they leave a key out, and the two
         * mean the same thing here.
         */
        if (raw === undefined || raw === null) continue;
        const checked = check(child, raw, `${path}.${name}`);
        if (!checked.ok) return checked;
        out[name] = checked.value;
      }
      return { ok: true, value: out };
    }
    default:
      return fail(path, "has a schema this checker cannot read");
  }
}
