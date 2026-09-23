import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { routes, routeList } from "../src/contracts/index";
import { MoneyString, PageRequest, Uuid } from "../src/contracts/common";
import { defineRoute, type RouteDefinition } from "../src/lib/define";
import { buildOpenApiDocument, type OpenApiDocument, type OperationObject } from "../src/lib/openapi";

/**
 * GUARDS ON THE GENERATED DOCUMENT
 *
 * Every test here was checked by breaking the thing it guards and watching it
 * go red. A guard that stays green while the code is wrong is worse than no
 * guard: it is a reason not to look.
 *
 * Most of them run against a small registry declared in this file rather than
 * against the product's, because the properties that matter (an internal
 * route is excluded, a path parameter is not also a body field) need a
 * registry that contains the case. Asserting "the document has some paths"
 * against the real registry passes against almost any bug.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const METHODS = ["get", "post", "patch", "put", "delete"] as const;

/** Read off the contract rather than retyped, so the guard cannot drift from it. */
const moneyPattern = (): string => {
  for (const check of MoneyString._def.checks) if (check.kind === "regex") return check.regex.source;
  throw new Error("MoneyString no longer carries a regex, so this guard is no longer guarding anything.");
};

const operationsOf = (document: OpenApiDocument): Array<{ path: string; method: string; operation: OperationObject }> => {
  const out: Array<{ path: string; method: string; operation: OperationObject }> = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation) out.push({ path, method, operation });
    }
  }
  return out;
};

/** Every `$ref` in the document, so a component nothing defines is caught. */
const refsOf = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) refsOf(entry, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof entry === "string") found.push(entry);
      else refsOf(entry, found);
    }
  }
  return found;
};

/** Every schema node in the document, flattened, for the money walk. */
const nodesOf = (value: unknown, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    for (const entry of value) nodesOf(entry, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    found.push(value as Record<string, unknown>);
    for (const entry of Object.values(value as Record<string, unknown>)) nodesOf(entry, found);
  }
  return found;
};

/**
 * A registry with one of everything the generator has to get right: an
 * internal route, a path parameter, a GET whose input is a query, money in
 * both directions, and all three kinds of authorization.
 */
const fixture = {
  listWidgets: defineRoute({
    method: "get",
    path: "/v1/widgets",
    summary: "List widgets",
    module: "M01",
    permissions: ["widget:read"],
    input: PageRequest.extend({ search: z.string().optional() }),
    output: z.object({ data: z.array(z.object({ id: Uuid, price: MoneyString })) }),
  }),
  priceWidget: defineRoute({
    method: "post",
    path: "/v1/widgets/{id}/price",
    summary: "Reprice a widget",
    module: "M01",
    permissions: ["widget:write"],
    idempotent: true,
    input: z.object({ id: Uuid, price: MoneyString, note: z.string().optional() }),
    output: z.object({ id: Uuid, price: MoneyString }),
  }),
  viewWidgetAsCustomer: defineRoute({
    method: "get",
    path: "/v1/portal/widget",
    summary: "View a widget from a link",
    module: "M05",
    permissions: [],
    authorization: "grant",
    input: z.object({ token: z.string().min(20).max(200) }),
    output: z.object({ id: Uuid, price: MoneyString }),
  }),
  publicWidgets: defineRoute({
    method: "get",
    path: "/v1/public/widgets",
    summary: "What a stranger may see",
    module: "M05",
    permissions: [],
    authorization: "public",
    input: z.object({ organizationSlug: z.string().min(1) }),
    output: z.object({ names: z.array(z.string()) }),
  }),
  rebuildSearchIndex: defineRoute({
    method: "post",
    path: "/v1/internal/reindex",
    summary: "Rebuild the search index",
    module: "M01",
    permissions: ["widget:write"],
    internal: true,
    input: z.object({ since: z.string().datetime().optional() }),
    output: z.object({ queued: z.number().int() }),
  }),
} as const satisfies Record<string, RouteDefinition>;

const fixtureDocument = buildOpenApiDocument(fixture);
const document = buildOpenApiDocument(routes);

describe("drift between the registry and the document", () => {
  it("documents every published route and nothing else", () => {
    const expected = Object.entries(routes)
      .filter(([, route]) => route.internal !== true)
      .map(([name, route]) => `${name} ${route.method.toUpperCase()} ${route.path}`)
      .sort();

    const actual = operationsOf(document)
      .map(({ path, method, operation }) => `${operation.operationId} ${method.toUpperCase()} ${path}`)
      .sort();

    expect(actual).toEqual(expected);
    // Non-vacuous: the product has routes, so an empty document is a failure
    // and not a pass.
    expect(actual.length).toBe(routeList.filter((r) => r.internal !== true).length);
    expect(actual.length).toBeGreaterThan(20);
  });

  it("leaves an internal route out, and keeps the rest", () => {
    const ids = operationsOf(fixtureDocument).map(({ operation }) => operation.operationId);
    expect(ids).not.toContain("rebuildSearchIndex");
    expect(fixtureDocument.paths["/v1/internal/reindex"]).toBeUndefined();
    expect(ids.sort()).toEqual(["listWidgets", "priceWidget", "publicWidgets", "viewWidgetAsCustomer"]);
    // The internal route's schemas go with it. A component nothing reaches is
    // a type in every generated SDK for an endpoint nobody may call.
    expect(Object.keys(fixtureDocument.components.schemas)).not.toContain("RebuildSearchIndexInput");
  });

  it("the checked in openapi.json is what the generator produces now", () => {
    const committed = readFileSync(resolve(HERE, "../openapi.json"), "utf8");
    expect(
      committed,
      "openapi.json is stale. Regenerate it: pnpm --filter @opentradesos/api run openapi",
    ).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});

describe("money on the wire", () => {
  /**
   * The failure this prevents: a JSON Schema conversion that reads the money
   * regex and decides the field is numeric. Every SDK generated from the
   * document would then parse 1234.56 into an IEEE 754 double, and every
   * integrator built on that SDK inherits a rounding bug in an invoice total.
   */
  it("MoneyString is a string in the document, in both directions", () => {
    const output = fixtureDocument.components.schemas["PriceWidgetOutput"];
    expect(output).toBeDefined();
    const price = (output?.["properties"] as Record<string, Record<string, unknown>>)["price"];
    expect(price?.["type"]).toBe("string");
    expect(price?.["pattern"]).toBe(moneyPattern());

    const input = fixtureDocument.components.schemas["PriceWidgetInput"];
    const inputPrice = (input?.["properties"] as Record<string, Record<string, unknown>>)["price"];
    expect(inputPrice?.["type"]).toBe("string");
  });

  it("no money or rate field anywhere in the product document is a number", () => {
    const decimals = nodesOf(document).filter((node) => {
      const pattern = node["pattern"];
      return typeof pattern === "string" && /^\^-\?\\d\+/.test(pattern);
    });

    // Non-vacuous: the product is full of money, so finding none would mean
    // the walk is broken rather than that the document is clean.
    expect(decimals.length).toBeGreaterThan(50);

    for (const node of decimals) {
      const type = node["type"];
      const types = Array.isArray(type) ? type : [type];
      expect(types, `a decimal string was documented as ${JSON.stringify(type)}`).toContain("string");
      expect(types).not.toContain("number");
      expect(types).not.toContain("integer");
    }
  });
});

describe("authorization", () => {
  const byId = new Map(operationsOf(document).map(({ operation }) => [operation.operationId, operation]));

  it("a public route is not documented as requiring a session", () => {
    const publicRoutes = Object.entries(routes).filter(
      ([, route]) => route.internal !== true && route.authorization === "public",
    );
    expect(publicRoutes.length).toBeGreaterThan(0);

    for (const [name] of publicRoutes) {
      const operation = byId.get(name);
      expect(operation, `${name} is missing from the document`).toBeDefined();
      expect(operation?.security, `${name} is public and must carry no security requirement`).toEqual([]);
      expect(JSON.stringify(operation?.security)).not.toContain("sessionCookie");
      expect(operation?.["x-authorization"]).toBe("public");
      expect(operation?.["x-permissions"]).toEqual([]);
      // 401 is the answer to a missing session. A public route has no session
      // to miss, and documenting one tells an integrator to go and find
      // credentials that do not exist.
      expect(Object.keys(operation?.responses ?? {})).not.toContain("401");
    }
  });

  it("a session route is documented as requiring one, with its permissions", () => {
    const sessionRoutes = Object.entries(routes).filter(
      ([, route]) => route.internal !== true && (route.authorization ?? "session") === "session",
    );
    expect(sessionRoutes.length).toBeGreaterThan(20);

    for (const [name, route] of sessionRoutes) {
      const operation = byId.get(name);
      expect(operation?.security, `${name} needs a session and must say so`).toEqual([
        { sessionCookie: [] },
        { appToken: [] },
      ]);
      expect(operation?.["x-authorization"]).toBe("session");
      expect(operation?.["x-permissions"]).toEqual([...route.permissions]);
      expect(Object.keys(operation?.responses ?? {})).toContain("401");
      expect(Object.keys(operation?.responses ?? {})).toContain("403");
    }
  });

  it("session, grant and public are three visibly different things", () => {
    const session = fixtureDocument.paths["/v1/widgets"]?.get;
    const grant = fixtureDocument.paths["/v1/portal/widget"]?.get;
    const open = fixtureDocument.paths["/v1/public/widgets"]?.get;

    expect([session?.["x-authorization"], grant?.["x-authorization"], open?.["x-authorization"]]).toEqual([
      "session",
      "grant",
      "public",
    ]);

    // Grant and public both take no HTTP credential, so `security` alone
    // cannot tell them apart. The document has to distinguish them somewhere
    // a reader will look, and a description that is identical for the two is
    // the failure this catches.
    expect(new Set([session?.description, grant?.description, open?.description]).size).toBe(3);
    expect(grant?.description).toContain("token");
    expect(open?.description).toContain("no credential");
  });

  it("the idempotency key is a header, on the routes that honour it", () => {
    const priced = fixtureDocument.paths["/v1/widgets/{id}/price"]?.post;
    const key = priced?.parameters?.find((p) => p.name === "idempotency-key");
    expect(key?.in).toBe("header");
    expect(key?.required).toBe(false);
    // Never a body field. A client that regenerates its body on retry would
    // regenerate the key inside it, and the retry would not be a retry.
    const schema = fixtureDocument.components.schemas["PriceWidgetInput"];
    expect(Object.keys((schema?.["properties"] ?? {}) as Record<string, unknown>)).not.toContain("idempotency-key");
    expect(Object.keys((schema?.["properties"] ?? {}) as Record<string, unknown>)).not.toContain("idempotencyKey");

    /**
     * And NOT on a grant or public route. dispatch.ts only reads the header
     * inside the session branch, so documenting it on the portal's idempotent
     * routes would promise a retry safety nothing implements.
     */
    for (const { operation } of operationsOf(document)) {
      if (operation["x-authorization"] === "session") continue;
      expect(
        operation.parameters?.map((p) => p.name) ?? [],
        `${operation.operationId} is not session authorized, so its idempotency-key header is ignored`,
      ).not.toContain("idempotency-key");
    }
  });
});

describe("where the input goes", () => {
  it("a path parameter is in the path, required, and not in the body", () => {
    const operation = fixtureDocument.paths["/v1/widgets/{id}/price"]?.post;
    const id = operation?.parameters?.find((p) => p.name === "id");
    expect(id?.in).toBe("path");
    expect(id?.required).toBe(true);
    expect(id?.schema["format"]).toBe("uuid");

    const body = fixtureDocument.components.schemas["PriceWidgetInput"];
    const properties = Object.keys((body?.["properties"] ?? {}) as Record<string, unknown>);
    expect(properties).not.toContain("id");
    expect(properties).toContain("price");
    expect(body?.["required"]).not.toContain("id");
  });

  it("every path parameter in the product is declared, required, and out of the body", () => {
    let seen = 0;
    for (const { path, operation } of operationsOf(document)) {
      const declared = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      for (const name of declared) {
        seen += 1;
        const parameter = operation.parameters?.find((p) => p.name === name && p.in === "path");
        expect(parameter, `${operation.operationId} does not document {${name}}`).toBeDefined();
        expect(parameter?.required).toBe(true);

        const ref = operation.requestBody?.content["application/json"]?.schema["$ref"];
        if (typeof ref === "string") {
          const body = document.components.schemas[ref.replace("#/components/schemas/", "")];
          expect(
            Object.keys((body?.["properties"] ?? {}) as Record<string, unknown>),
            `${operation.operationId} repeats {${name}} in its body, where the dispatcher ignores it`,
          ).not.toContain(name);
        }
        expect(operation.parameters?.filter((p) => p.name === name && p.in === "query")).toEqual([]);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("a GET takes query parameters and no body", () => {
    const operation = fixtureDocument.paths["/v1/widgets"]?.get;
    expect(operation?.requestBody).toBeUndefined();
    const query = (operation?.parameters ?? []).filter((p) => p.in === "query");
    expect(query.map((p) => p.name).sort()).toEqual(["cursor", "limit", "search"]);
    // `limit` has a default, so it is not required of the caller.
    expect(query.find((p) => p.name === "limit")?.required).toBe(false);
    expect(query.find((p) => p.name === "limit")?.schema["type"]).toBe("integer");

    for (const { method, operation: op } of operationsOf(document)) {
      if (method !== "get") continue;
      expect(op.requestBody, `${op.operationId} is a GET and cannot carry a body`).toBeUndefined();
    }
  });

  it("a required query parameter stays required", () => {
    const open = fixtureDocument.paths["/v1/public/widgets"]?.get;
    expect(open?.parameters?.find((p) => p.name === "organizationSlug")?.required).toBe(true);
  });

  it("a non-GET carries its input as a request body", () => {
    for (const { method, operation } of operationsOf(document)) {
      if (method === "get") continue;
      expect(operation.requestBody, `${operation.operationId} has no documented body`).toBeDefined();
      expect(operation.parameters?.filter((p) => p.in === "query") ?? []).toEqual([]);
    }
  });
});

describe("what the dispatcher answers", () => {
  it("201 on a post, 200 otherwise", () => {
    for (const { method, operation } of operationsOf(document)) {
      const success = Object.keys(operation.responses).filter((code) => code.startsWith("2"));
      expect(success, `${operation.operationId}`).toEqual([method === "post" ? "201" : "200"]);
    }
  });

  it("only a method that reads a body can answer 400", () => {
    for (const { method, operation } of operationsOf(document)) {
      const has = Object.keys(operation.responses).includes("400");
      // dispatch.ts parses a body for everything except GET and DELETE.
      expect(has, `${operation.operationId}`).toBe(method !== "get" && method !== "delete");
    }
  });

  it("every operation documents the validation failure with its field paths", () => {
    for (const { operation } of operationsOf(document)) {
      const schema = operation.responses["422"]?.content?.["application/json"]?.schema;
      expect(schema?.["$ref"], `${operation.operationId}`).toBe("#/components/schemas/ValidationError");
    }
    const validation = document.components.schemas["ValidationError"];
    const properties = (validation?.["properties"] ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["error", "issues", "status"]);
  });

  it("the 405 and its allow header are described where a 405 can happen", () => {
    const allowed = document.components.responses["MethodNotAllowed"];
    expect(allowed?.headers?.["allow"]).toBeDefined();

    const shared = Object.entries(document.paths).find(([, item]) => item["x-allowed-methods"].length > 1);
    expect(shared, "no path serves more than one method, so the fixture proves nothing").toBeDefined();
    const [path, item] = shared!;
    const served = METHODS.filter((m) => item[m] !== undefined).map((m) => m.toUpperCase()).sort();
    expect(item["x-allowed-methods"], `${path}`).toEqual(served);
    expect(item.description).toContain("allow");
  });
});

describe("the document is structurally an OpenAPI 3.1 document", () => {
  /**
   * There is no OpenAPI validator in this repo and adding a dependency is out
   * of scope here, so these are the invariants a validator would check that
   * can be checked without one. What is NOT checked: the JSON Schema dialect
   * of every schema node, and the vocabulary rules a real validator applies.
   */
  it("declares 3.1.0 with the fields the spec requires", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(typeof document.info.title).toBe("string");
    expect(typeof document.info.version).toBe("string");
    expect(document.info.title.length).toBeGreaterThan(0);
  });

  it("every $ref resolves to a component that exists", () => {
    const defined = new Set(Object.keys(document.components.schemas));
    const refs = refsOf(document);
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/"), ref).toBe(true);
      expect(defined, `${ref} is referenced and not defined`).toContain(ref.replace("#/components/schemas/", ""));
    }
  });

  it("defines no component that nothing references", () => {
    const referenced = new Set(refsOf(document).map((ref) => ref.replace("#/components/schemas/", "")));
    for (const name of Object.keys(document.components.schemas)) {
      expect(referenced, `${name} is defined and unreachable`).toContain(name);
    }
  });

  it("every operation is well formed and every operationId is unique", () => {
    const ids = new Set<string>();
    for (const { path, operation } of operationsOf(document)) {
      expect(path.startsWith("/"), path).toBe(true);
      expect(ids.has(operation.operationId), `${operation.operationId} is used twice`).toBe(false);
      ids.add(operation.operationId);
      expect(operation.summary.length).toBeGreaterThan(0);
      expect(operation.tags.length).toBeGreaterThan(0);
      for (const tag of operation.tags) {
        expect(document.tags.map((t) => t.name), `${tag} is used and not declared`).toContain(tag);
      }
      for (const [code, response] of Object.entries(operation.responses)) {
        expect(/^[1-5]\d\d$/.test(code), `${operation.operationId} answers ${code}`).toBe(true);
        expect(response.description.length).toBeGreaterThan(0);
      }
      for (const parameter of operation.parameters ?? []) {
        expect(["path", "query", "header"]).toContain(parameter.in);
        expect(typeof parameter.schema).toBe("object");
        if (parameter.in === "path") expect(parameter.required).toBe(true);
      }
      for (const requirement of operation.security) {
        for (const scheme of Object.keys(requirement)) {
          expect(Object.keys(document.components.securitySchemes), scheme).toContain(scheme);
        }
      }
    }
  });

  it("carries no em dash or en dash, which this repo bans everywhere", () => {
    // Built from escapes so this guard does not itself smuggle one in.
    const dashes = new RegExp("[\\u2013\\u2014]");
    expect(dashes.test(JSON.stringify(document))).toBe(false);
  });
});
