import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { modules as moduleRegistry } from "@opentradesos/core";
import type { Authorization, Method, RouteDefinition } from "./define";

/**
 * THE OPENAPI DOCUMENT
 *
 * Registry in, document out, no I/O. The CLI next to this file is what
 * touches the disk, so the whole generator is reachable from a test with a
 * three route registry and no fixtures on disk.
 *
 * Everything here is derived from the route registry and from what
 * src/http/dispatch.ts actually does with a request. Nothing is transcribed.
 * A document that describes an idealised API is worse than no document: it
 * sends an integrator looking for a bug in their own code.
 *
 * We convert schemas with @asteasolutions/zod-to-openapi rather than hand
 * rolling the zod walk, because a hand rolled converter silently emits `{}`
 * for the first zod type nobody thought about and an empty schema validates
 * everything.
 */

/**
 * Required by the library before any schema is converted. It adds `.openapi()`
 * to the zod prototypes; we never call it, but the generator reads the field
 * it installs and throws on schemas built before the patch.
 */
extendZodWithOpenApi(z);

type JsonSchema = Record<string, unknown>;

export interface ServerObject {
  url: string;
  description?: string;
}

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  explode?: boolean;
  schema: JsonSchema;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, { description: string; schema: JsonSchema }>;
  content?: Record<string, { schema: JsonSchema }>;
}

export interface OperationObject {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: ParameterObject[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, ResponseObject>;
  security: Array<Record<string, string[]>>;
  /** The declared `authorization`, kept machine readable: `security` alone cannot tell a grant route from a public one. */
  "x-authorization": Authorization;
  /** Every permission the caller must hold. Empty on grant and public routes, where nobody holds one. */
  "x-permissions": string[];
}

export type PathItemObject = {
  description: string;
  /** Derived from the registry, and the reason a 405 is answerable at all. */
  "x-allowed-methods": string[];
} & { [M in Method]?: OperationObject };

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string; license: { name: string; identifier: string } };
  servers: ServerObject[];
  tags: Array<{ name: string }>;
  paths: Record<string, PathItemObject>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
    responses: Record<string, ResponseObject>;
  };
}

export interface OpenApiOptions {
  title?: string;
  version?: string;
  servers?: readonly ServerObject[];
}

/**
 * The error envelope the dispatcher actually sends.
 *
 * NOT `ApiError` from the contracts. `problem()` in src/http/dispatch.ts
 * writes `{ error: <string>, status: <number>, ...extra }`, while `ApiError`
 * describes `{ error: { code, message, fields } }`. Documenting the contract
 * shape would hand every SDK a branch on `error.code` that is always
 * undefined, so this mirrors the dispatcher and the divergence is reported
 * rather than papered over.
 */
const ErrorBody = z.object({
  error: z.string(),
  status: z.number().int(),
});

/** 422 carries the field paths, because that is what lets a caller fix the request. */
const ValidationErrorBody = ErrorBody.extend({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

const MethodNotAllowedBody = ErrorBody.extend({
  allowed: z.array(z.string()),
});

const ERROR_REF = "#/components/schemas/Error";
const VALIDATION_ERROR_REF = "#/components/schemas/ValidationError";

/**
 * A session is either a person's cookie or a connected application's bearer
 * token: src/http/authenticate.ts accepts both on the same routes and they
 * produce the same actor. Documenting only the cookie would tell a partner
 * building against this that their token does not work here.
 */
const SECURITY_SCHEMES: Record<string, JsonSchema> = {
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "ots_session",
    description:
      "A signed in user's session cookie. The name is set by the host application that mounts the dispatcher; the reference Next.js app uses this one.",
  },
  appToken: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "ots_...",
    description:
      "A connected application's token. Checked before the cookie, and a rejected token is a refusal rather than a fallback to whoever is signed in on the same machine.",
  },
};

const PATH_PARAM = /\{([^}]+)\}/g;

export function buildOpenApiDocument(
  registry: Readonly<Record<string, RouteDefinition>>,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const published = Object.entries(registry)
    .filter(([, route]) => route.internal !== true)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const components = new OpenAPIRegistry();
  components.register("Error", ErrorBody);
  components.register("ValidationError", ValidationErrorBody);
  components.register("MethodNotAllowed", MethodNotAllowedBody);

  /** Component names per route, so the second pass does not recompute them. */
  const names = new Map<string, { input: string; output: string; params: string | null }>();

  for (const [name, route] of published) {
    const declared = pathParamsOf(route.path);
    const object = objectOf(route.input);
    if (!object) {
      // The dispatcher parses a merged plain object, so an input that is not
      // an object could never have parsed. Better a build failure here than a
      // document describing a route that cannot be called.
      throw new Error(`Route ${name} (${route.method.toUpperCase()} ${route.path}) has a non-object input schema.`);
    }

    const inParams = declared.filter((param) => param in object.shape);
    const inputName = `${capitalize(name)}Input`;
    const outputName = `${capitalize(name)}Output`;
    const paramsName = inParams.length > 0 ? `${capitalize(name)}PathParams` : null;

    // The body or query schema is the input MINUS the path parameters. A path
    // parameter repeated in the body is a second place to say the same thing,
    // and the dispatcher ignores whatever the body said: `match.params` is
    // merged last and wins.
    components.register(inputName, object.omit(maskOf(inParams)));
    components.register(outputName, route.output);
    if (paramsName) components.register(paramsName, object.pick(maskOf(inParams)));

    names.set(name, { input: inputName, output: outputName, params: paramsName });
  }

  const generated = new OpenApiGeneratorV31(components.definitions).generateComponents() as unknown as {
    components?: { schemas?: Record<string, JsonSchema> };
  };
  const schemas: Record<string, JsonSchema> = { ...(generated.components?.schemas ?? {}) };

  /** Methods served at each path, which is exactly what a 405 reports. */
  const servedAt = new Map<string, Method[]>();
  for (const [, route] of published) {
    const existing = servedAt.get(route.path) ?? [];
    existing.push(route.method);
    servedAt.set(route.path, existing);
  }

  const paths: Record<string, PathItemObject> = {};

  for (const [name, route] of published) {
    const componentNames = names.get(name)!;
    const inputSchema = schemas[componentNames.input] ?? {};
    const parameters: ParameterObject[] = [];

    if (componentNames.params) {
      const paramSchema = schemas[componentNames.params] ?? {};
      for (const param of pathParamsOf(route.path)) {
        parameters.push({
          name: param,
          in: "path",
          required: true,
          schema: propertyOf(paramSchema, param) ?? { type: "string" },
        });
      }
      // Consumed into `parameters`; a components entry nothing references
      // would show up in a generated SDK as a type no method takes.
      delete schemas[componentNames.params];
    } else {
      for (const param of pathParamsOf(route.path)) {
        // Declared in the path but absent from the input schema. Still
        // required to call the route, so it is documented as a string.
        parameters.push({ name: param, in: "path", required: true, schema: { type: "string" } });
      }
    }

    /**
     * GET input comes off the query string, never a body: the dispatcher only
     * reads a body for other methods, and `queryToInput` coerces numbers and
     * booleans against the schema's own shape.
     */
    const fromQuery = route.method === "get";
    if (fromQuery) {
      for (const [key, schema] of propertiesOf(inputSchema)) {
        parameters.push({
          name: key,
          in: "query",
          required: requiredOf(inputSchema).includes(key),
          // Repeated keys, not a comma separated list: `queryToInput` reads
          // `search.getAll(key)` for an array.
          ...(schema["type"] === "array" ? { explode: true } : {}),
          schema,
        });
      }
      delete schemas[componentNames.input];
    }

    const authorization: Authorization = route.authorization ?? "session";

    /**
     * The idempotency key is a HEADER and never a body field, and the
     * dispatcher only reads it inside the session branch. Documenting it on an
     * idempotent grant or public route would promise a retry safety that
     * nothing implements.
     */
    if (route.idempotent === true && authorization === "session") {
      parameters.push({
        name: "idempotency-key",
        in: "header",
        required: false,
        description:
          "Repeat the same key to retry this request without repeating its effect. A retry from a truck on bad signal must not become a second job or a second charge.",
        schema: { type: "string" },
      });
    }

    const operation: OperationObject = {
      operationId: name,
      summary: route.summary,
      description: describe(route, authorization),
      tags: [route.module],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(fromQuery
        ? {}
        : {
            requestBody: {
              required: requiredOf(inputSchema).length > 0,
              content: { "application/json": { schema: { $ref: `#/components/schemas/${componentNames.input}` } } },
            },
          }),
      responses: responsesFor(route, authorization, componentNames.output),
      security: securityFor(authorization),
      "x-authorization": authorization,
      "x-permissions": [...route.permissions],
    };

    const allowed = (servedAt.get(route.path) ?? []).map((m) => m.toUpperCase()).sort();
    const item: PathItemObject = paths[route.path] ?? {
      description: `Served at this path: ${allowed.join(", ")}. Any other method answers 405 with an \`allow\` header listing these, rather than a 404 that would send you hunting for a typo in a correct URL.`,
      "x-allowed-methods": allowed,
    };
    item[route.method] = operation;
    paths[route.path] = item;
  }

  const sortedPaths: Record<string, PathItemObject> = {};
  for (const path of Object.keys(paths).sort()) sortedPaths[path] = paths[path]!;

  const modules = [...new Set(published.map(([, route]) => route.module))].sort();

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "OpenTradesOS API",
      version: options.version ?? "0.0.0",
      description: DOCUMENT_DESCRIPTION,
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [...(options.servers ?? [{ url: "/api", description: "The reference deployment mounts the dispatcher here." }])],
    /**
     * The tag carries the module's NAME, not only its code. A reference
     * grouped into M13, M16 and M31 makes a reader hold a lookup table in
     * their head, and the one thing they cannot do with a bare code is
     * notice that a route is filed under the wrong one.
     */
    tags: modules.map((name) => ({ name, description: moduleRegistry.titleOf(name) })),
    paths: sortedPaths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas,
      responses: {
        /**
         * A 405 belongs to the path rather than to any operation, so it is
         * defined once here and pointed at from each path's description. An
         * operation that matched never answers 405, and listing it under one
         * would be a response no caller can ever see.
         */
        MethodNotAllowed: {
          description:
            "The path is served, but not for this method. The `allow` header lists the methods that are.",
          headers: {
            allow: { description: "The methods served at this path.", schema: { type: "string" } },
          },
          content: { "application/json": { schema: { $ref: "#/components/schemas/MethodNotAllowed" } } },
        },
      },
    },
  };
}

const DOCUMENT_DESCRIPTION = [
  "Generated from the route contracts in @opentradesos/api. Do not edit by hand: regenerate with `pnpm --filter @opentradesos/api run openapi`.",
  "",
  "Money and rates are decimal STRINGS, never JSON numbers. JSON numbers are IEEE 754 doubles, so 0.1 does not survive a round trip and a client in another language rounds it differently again.",
  "",
  "Lists are cursor paginated. Offset pagination skips or repeats rows when the underlying set changes between pages, which on a busy dispatch morning is most of the time.",
  "",
  "A request to a served path with a method it does not serve answers 405 with an `allow` header. A path nobody serves answers 404.",
].join("\n");

/**
 * What stands between a caller and the route, in the document.
 *
 * `session`, `grant` and `public` are three different things. Only a session
 * route carries a security requirement: a grant is a token inside the request
 * shape rather than an HTTP credential, and a public route takes nothing at
 * all. Documenting a public route as needing a session costs an integrator an
 * afternoon; the reverse hands a stranger a route they should not have found.
 */
function securityFor(authorization: Authorization): Array<Record<string, string[]>> {
  if (authorization === "session") return [{ sessionCookie: [] }, { appToken: [] }];
  // An empty list is OpenAPI for "no credential required" and overrides any
  // document level default. It is not the same as leaving the field out.
  return [];
}

function describe(route: RouteDefinition, authorization: Authorization): string {
  const lines: string[] = [];
  if (route.description) lines.push(route.description);

  if (authorization === "session") {
    lines.push(
      route.permissions.length > 0
        ? `Requires a session holding: ${[...route.permissions].join(", ")}.`
        : "Requires a session. No further permission is checked.",
    );
  } else if (authorization === "grant") {
    lines.push(
      "Authorized by a capability grant, held by a customer with no account and no session. The grant IS the permission: it is scoped to one record and expires. Its token travels in the `token` " +
        (route.method === "get" ? "query parameter" : "request body field") +
        ", so it is part of the request shape rather than an HTTP credential.",
    );
  } else {
    lines.push(
      "Open to anybody, with no credential of any kind. It returns nothing about any identified person. A connected application's bearer token is accepted here for attribution only, and never as a reason to refuse the request.",
    );
  }

  if (route.idempotent === true && authorization !== "session") {
    lines.push(
      "Declared idempotent, but the dispatcher only applies an `idempotency-key` header on session authorized routes, so a retry of this route is NOT currently a no-op.",
    );
  }

  return lines.join("\n\n");
}

/**
 * The status codes the dispatcher can actually produce for this route.
 *
 * Not a fixed list pasted onto every operation: a GET never answers 400
 * because it never reads a body, and only a session route can answer 401 or
 * 403 because only a session route has anything to check.
 */
function responsesFor(
  route: RouteDefinition,
  authorization: Authorization,
  outputName: string,
): Record<string, ResponseObject> {
  const responses: Record<string, ResponseObject> = {};

  // 201 on post, 200 on everything else. Straight from `dispatch`.
  const success = route.method === "post" ? "201" : "200";
  responses[success] = {
    description: route.summary,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${outputName}` } } },
  };

  // A body is only read, and so only rejected as malformed, for methods that
  // carry one. GET and DELETE never reach that branch.
  if (route.method !== "get" && route.method !== "delete") {
    responses["400"] = error("The request body is not valid JSON, or is not a JSON object.");
  }

  if (authorization === "session") {
    responses["401"] = error("No session and no valid application token. Sign in, or present a token that has not been revoked.");
    responses["403"] = error(
      "Authenticated and not allowed. Deliberately not a 401: telling a signed in user to sign in again will not help them.",
    );
  }

  responses["404"] = error("The record was not found, or is outside this caller's tenant.");
  responses["409"] = error("The request conflicts with the current state of the record.");
  responses["422"] = {
    description: "The input did not match the schema. `issues` carries the field path for each failure.",
    content: { "application/json": { schema: { $ref: VALIDATION_ERROR_REF } } },
  };
  responses["500"] =
    authorization === "grant"
      ? error(
          "An unhandled error. NOTE: an expired, revoked or spent grant currently surfaces here rather than as a 401 or 403, because the dispatcher does not recognise the grant error.",
        )
      : error("An unhandled error. The message is never echoed back, so nothing internal leaks into a browser.");

  return responses;
}

const error = (description: string): ResponseObject => ({
  description,
  content: { "application/json": { schema: { $ref: ERROR_REF } } },
});

function pathParamsOf(path: string): string[] {
  const out: string[] = [];
  for (const found of path.matchAll(PATH_PARAM)) {
    const name = found[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

/**
 * The plain object underneath an input schema.
 *
 * Mirrors the unwrapping in src/http/dispatch.ts, and exists for the same
 * reason: a `.refine()` on an input wraps the object in a ZodEffects, and a
 * generator that gave up there would document a route's whole input as an
 * empty schema.
 */
function objectOf(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 10; i += 1) {
    if (current instanceof z.ZodObject) return current as z.ZodObject<z.ZodRawShape>;
    if (current instanceof z.ZodEffects) current = current.innerType() as z.ZodTypeAny;
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap() as z.ZodTypeAny;
    else if (current instanceof z.ZodDefault) current = current.removeDefault() as z.ZodTypeAny;
    else return null;
  }
  return null;
}

const maskOf = (keys: readonly string[]): { [k: string]: true } => {
  const mask: { [k: string]: true } = {};
  for (const key of keys) mask[key] = true;
  return mask;
};

function propertiesOf(schema: JsonSchema): Array<[string, JsonSchema]> {
  const properties = schema["properties"];
  if (properties === undefined || properties === null || typeof properties !== "object") return [];
  return Object.entries(properties as Record<string, JsonSchema>);
}

function propertyOf(schema: JsonSchema, key: string): JsonSchema | undefined {
  return propertiesOf(schema).find(([name]) => name === key)?.[1];
}

function requiredOf(schema: JsonSchema): string[] {
  const required = schema["required"];
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
}

const capitalize = (value: string): string => (value === "" ? value : value[0]!.toUpperCase() + value.slice(1));
