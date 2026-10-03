import { describe, it, expect } from "vitest";
import { routes, routeList } from "../src/contracts/index.js";
import { handlers, PENDING_ROUTES, routeNames } from "../src/routes/index";
import * as services from "../src/services/index";
import { ALL_PERMISSIONS } from "../../core/src/access/permissions.js";

/**
 * Cross package invariants. These are cheap to run and catch the class of
 * mistake that is otherwise found in production by a customer: a route
 * guarding on a permission that does not exist guards on nothing.
 */

describe("permissions", () => {
  it("every route guards on permissions that actually exist", () => {
    for (const route of routeList) {
      for (const p of route.permissions) {
        expect(
          ALL_PERMISSIONS as readonly string[],
          `${route.method.toUpperCase()} ${route.path} requires unknown permission "${p}"`,
        ).toContain(p);
      }
    }
  });

  /**
   * A write with no permissions is either a hole or a deliberate decision, and
   * the two look identical in the code. So the decision has to be written
   * down: a route reachable without a session says which of the two other
   * things it is, and anything that says nothing must be guarded.
   */
  it("every non-GET route is either permissioned or explicitly not session authorized", () => {
    for (const route of routeList) {
      if (route.method === "get" || route.internal) continue;
      const auth = route.authorization ?? "session";
      if (auth !== "session") continue;
      expect(route.permissions.length, `${route.path} is unguarded`).toBeGreaterThan(0);
    }
  });

  it("a route reachable without a session declares no permissions to hold", () => {
    for (const route of routeList) {
      const auth = route.authorization ?? "session";
      if (auth === "session") continue;
      expect(
        route.permissions,
        `${route.path} is authorized by ${auth} but expects permissions nobody without a session can hold`,
      ).toHaveLength(0);
    }
  });

  /**
   * The portal and booking surface is the only part of the product a stranger
   * can reach, so the count of routes in it is worth pinning. A route that
   * quietly joins this set should be a deliberate change, visible in a diff,
   * not something noticed later.
   */
  it("only the customer facing surface is reachable without a session", () => {
    const open = routeList
      .filter((r) => (r.authorization ?? "session") !== "session")
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)
      .sort();

    expect(open).toEqual([
      /**
       * A signed in customer's account and saved cards. The token is a
       * customer scope grant opened by a code sent to the address on the
       * customer's own record, reaching that customer and nobody else. The
       * cards route answers a sign in only, never an account link, and
       * returns the brand, last four and expiry, which is all that is kept.
       */
      "GET /v1/portal/account",
      "GET /v1/portal/cards",
      "GET /v1/portal/estimate",
      /**
       * An invoice a customer opens from the link in the email, and the pay
       * action on the same page. Grant reachable rather than public: the
       * token IS the authority, which is the whole point of the mechanism,
       * and a customer settling a bill has no account and never will.
       *
       * Two things make this safe to have on the list. The invoice id comes
       * from the grant rather than from the request, so there is no id to
       * tamper with, and the pay action reads the amount from the invoice
       * balance rather than from anything the browser sent. Still no payment
       * is created here: a signed processor webhook remains the only thing
       * that can say money moved.
       */
      "GET /v1/portal/invoice",
      "GET /v1/portal/job",
      /**
       * The customer's own referral link, from their account link. The grant
       * names the customer; the answer is their code and the first names of
       * people they sent, nothing about anybody else's account.
       */
      "GET /v1/portal/referral",
      "GET /v1/portal/session",
      /**
       * A customer asking to move or cancel a visit from the link they were
       * sent. The grant decides which visits it reaches; a visit id in the
       * request only narrows inside that. Asking writes a request and a task
       * and moves nothing: the office approves, behind `visit:reschedule`.
       */
      "GET /v1/portal/visit-change",
      "GET /v1/public/availability",
      /**
       * The website snippet's two calls and the hosted form's read. All three
       * take a company's public key (its slug) and return nothing about
       * anybody: a pool number to show, and a form's fields. The snippet's
       * touch keeps attribution parameters only, and all of them are counted
       * per key and refused past a ceiling.
       */
      "GET /v1/public/dni",
      "GET /v1/public/hosted-forms/{key}",
      "GET /v1/public/services",
      /**
       * The phone app signing in. Open because nobody is signed in yet, and
       * it is the one entry on this list that is not customer facing, so the
       * reason is worth stating: it is the sign in form in another shape. It
       * runs the form's own password check and lockout, and hands out nothing
       * but a session for somebody who is a technician. Like the forms, it
       * has no rate limit by address in this product; the per account lockout
       * is what stops guessing.
       */
      "POST /v1/field/sign-in",
      /**
       * What a signed in customer does with their own account: open one of
       * their records as a narrower link (sign in only), pay an invoice
       * with a tip, save, remove and pay with a card (sign in only). Every
       * id in these requests is checked against the customer the token
       * names; another customer's is the same not found as one that does
       * not exist. A card's number never reaches the server, and no payment
       * is recorded here: the processor's signed webhook still decides.
       */
      "POST /v1/portal/account/open",
      "POST /v1/portal/account/pay",
      "POST /v1/portal/card-setup",
      "POST /v1/portal/card-setup/confirm",
      "POST /v1/portal/cards/{cardId}/pay",
      "POST /v1/portal/cards/{cardId}/remove",
      /**
       * The same sign in with a code instead of a password. Asking for a code
       * answers one sentence whether or not the address belongs to anybody,
       * so it is not a way to learn who works where; it is limited per
       * address per minute and per person to three codes in fifteen minutes,
       * and it sends only to the number or address the company holds, never
       * one the asker chose. Trying a code is limited per address too, and a
       * code dies after five wrong guesses, ten minutes, or one use.
       */
      "POST /v1/field/sign-in/code",
      "POST /v1/field/sign-in/verify",
      "POST /v1/portal/estimate/approve",
      "POST /v1/portal/estimate/decline",
      "POST /v1/portal/invoice/pay",
      "POST /v1/portal/sign-out",
      "POST /v1/portal/visit-change",
      "POST /v1/public/bookings",
      /**
       * A lead form on a company's own website, filled in by a homeowner
       * with no account. Public by necessity, like the booking endpoint
       * beside it.
       *
       * What protects it: core's honeypot field and its minimum fill time,
       * which mark a submission `spam` rather than refusing it, so the
       * evidence stays. What does NOT protect it, and is worth saying here
       * rather than leaving somebody to assume: there is no rate limit in
       * this product. A deployment exposing this to the internet puts one
       * in front of it, the same as for the booking endpoint.
       */
      "POST /v1/public/forms/{formSlug}",
      /**
       * A customer signing in: ask for a code, then trade it for a session.
       * Open because nobody is signed in yet. Neither says whether an
       * address belongs to anybody. Asking is counted per address and per
       * network address before anything is sent; a code lives ten minutes,
       * works once, dies after five wrong tries, and only its hash is kept.
       */
      "POST /v1/public/portal/{organizationSlug}/codes",
      "POST /v1/public/portal/{organizationSlug}/sign-in",
      "POST /v1/public/touches",
      /**
       * UNSUBSCRIBE, AND IT HAS TO BE OPEN. A recipient pressing the
       * unsubscribe control in Gmail has no account, and the mailbox provider
       * making the RFC 8058 POST on their behalf is a server with no
       * credential of any kind. A gate here would mean the one click
       * unsubscribe both Gmail and Yahoo require from bulk senders does not
       * work, which is how a sending domain stops being delivered.
       *
       * What makes it safe: the token is 32 random bytes and only its hash is
       * stored, an unknown token gets the same answer as one that never
       * existed so this cannot be used to test whether a token is live, the
       * address comes back masked because the link can be forwarded, and the
       * GET writes nothing. The last one is the important one: every link
       * prefetcher and mail scanner follows URLs in inbound mail, so a GET
       * that unsubscribed would opt a company's whole list out over a few
       * months with no human having clicked anything.
       *
       * The worst a stranger with a stolen token can do is stop that one
       * address getting marketing email, which is also what the address's
       * owner wanted the link for.
       */
      "GET /v1/public/unsubscribe/{token}",
      "POST /v1/public/unsubscribe/{token}",
    ].sort());
  });
});

describe("money routes are idempotent", () => {
  /**
   * A retried payment that is not idempotent is a second charge. This test is
   * the reason the flag exists on the definition rather than in a convention.
   */
  const MONEY_PATHS = ["/v1/payments", "/v1/invoices"];

  it("every write route touching money requires an idempotency key", () => {
    for (const route of routeList) {
      if (route.method === "get") continue;
      if (!MONEY_PATHS.some((p) => route.path.startsWith(p))) continue;
      expect(route.idempotent, `${route.path} handles money without idempotency`).toBe(true);
    }
  });

  /**
   * Every POST, not just the money ones. A client on a truck with bad signal
   * retries, and the first version of this test was loose enough to miss a
   * route that could have created a duplicate link on a retry.
   */
  /**
   * The one POST whose response cannot be replayed, with the reason.
   *
   * Issuing an app token returns a secret and stores only its hash, so there is
   * nothing on the server to hand back on a retry. The honest options were a
   * route that lies about being idempotent and a route that says it is not, and
   * this is the second one. A retry leaves a second token, which an operator can
   * see in the list by its label and last four characters and revoke; the
   * alternative, storing the plaintext so a replay could return it, would be a
   * token a support engineer could read out of a table, which is the property the
   * whole module is built to avoid.
   */
  const NOT_REPLAYABLE: Record<string, string> = {
    "/v1/public/portal/{organizationSlug}/sign-in":
      "The response is the customer's session token and only its hash is "
      + "stored, so a replay has nothing to return. The code is spent by the "
      + "first request, so a retry is refused and the customer asks for a new "
      + "code, which is the same thing that happens when a code expires.",
    "/v1/portal/account/open":
      "The response is a new link for one record and only its hash is "
      + "stored, so a replay has nothing to return. A retry leaves a second "
      + "link to the same record, for the same customer, which expires in a day.",
    "/v1/apps/{appId}/tokens":
      "The response is a secret and only its hash is stored, so a replay has "
      + "nothing to return. A retry leaves a second token, visible in the list "
      + "by its label and revocable.",
    "/v1/field/sign-in":
      "The response is the phone's token and only its hash is stored, so a "
      + "replay has nothing to return. A retry leaves a second token, and the "
      + "phone registering with whichever one it received ends the other, so a "
      + "handset never holds more than one that works.",
    "/v1/field/sign-in/verify":
      "The same token as the password sign in, for the same reason, and the "
      + "code it spends is single use: a replay of a request that worked finds "
      + "the code already spent and is refused, so it cannot mint a second token.",
    "/v1/field/sign-in/code":
      "The effect is a text or an email with a fresh code, which replaces the "
      + "one before it. A replay sends another and the newest is the one that "
      + "works, which is what a person pressing send again expects; the window "
      + "allows three in fifteen minutes, so a retry costs one of them.",
  };

  it("every POST is idempotent, because clients on bad connections retry", () => {
    for (const route of routeList) {
      if (route.method !== "post") continue;
      if (route.path in NOT_REPLAYABLE) continue;
      expect(
        route.idempotent,
        `POST ${route.path} is not idempotent, so a retry duplicates it`,
      ).toBe(true);
    }
  });

  it("every POST excused from that is a real route with a real reason", () => {
    /**
     * Both directions, so the list cannot go stale in the reassuring one: an
     * excused path that is not a route any more, or one that has since been made
     * idempotent and left here, are each a note the next reader will believe.
     */
    for (const [path, reason] of Object.entries(NOT_REPLAYABLE)) {
      const route = routeList.find((r) => r.path === path && r.method === "post");
      expect(route, `${path} is a POST route`).toBeDefined();
      expect(route?.idempotent, `${path} is excused and also claims to be idempotent`)
        .not.toBe(true);
      expect(reason.length, `${path} says why`).toBeGreaterThan(60);
    }
  });
});

describe("route hygiene", () => {
  it("has no duplicate method and path pairs", () => {
    const seen = new Set<string>();
    for (const route of routeList) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), `duplicate route ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("uses versioned paths", () => {
    for (const route of routeList) {
      expect(route.path.startsWith("/v1/"), `${route.path} is not versioned`).toBe(true);
    }
  });

  it("names a module so docs and permissions group the same way", () => {
    for (const route of routeList) {
      expect(route.module, `${route.path} has no module`).toMatch(/^M\d{2}$/);
    }
  });
});

describe("money is never a JSON number", () => {
  it("rejects a float and accepts a decimal string", () => {
    const line = routes.createInvoice.input.shape.lines.element.shape.unitPrice;
    expect(line.safeParse(12.34).success).toBe(false);
    expect(line.safeParse("12.34").success).toBe(true);
    expect(line.safeParse("12.34567").success).toBe(false);
    expect(line.safeParse("-5").success).toBe(true);
  });
});

describe("the contracts describe the domain correctly", () => {
  it("a job create can omit parties entirely, keeping residential simple", () => {
    const parsed = routes.createJob.input.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      propertyId: "22222222-2222-2222-2222-222222222222",
      summary: "No heat upstairs",
    });
    expect(parsed.success).toBe(true);
  });

  it("a job create accepts the three party commercial case", () => {
    const parsed = routes.createJob.input.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      propertyId: "22222222-2222-2222-2222-222222222222",
      summary: "Quarterly PM",
      parties: [
        { role: "requester", externalName: "Corrigo", externalReference: "WO-88213" },
        { role: "site_contact", contactId: "33333333-3333-3333-3333-333333333333" },
        { role: "payer", externalName: "Regional FM Co" },
      ],
      coverage: { source: "contract", coversLabour: true, coversParts: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("completing a visit carries the offline timestamp", () => {
    const parsed = routes.completeVisit.input.safeParse({
      id: "44444444-4444-4444-4444-444444444444",
      completedOfflineAt: "2026-09-23T14:05:00.000Z",
      technicianNotes: "Replaced capacitor, unit running",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("every route has something behind it", () => {
  /**
   * A contract with no implementation is worse than no contract. The OpenAPI
   * document, the generated SDK and the MCP tool list are all built from
   * `routes`, so a declared route with nothing serving it is an endpoint three
   * separate consumers will offer and none of them can call.
   *
   * PENDING_ROUTES is the escape hatch and it is deliberately loud: a name in
   * it is a promise the code does not keep, so it should only ever shrink.
   */
  it("implements or explicitly defers every route", () => {
    const implemented = new Set(Object.keys(handlers));
    const deferred = new Set(PENDING_ROUTES);

    const orphans = routeNames.filter((n) => !implemented.has(n) && !deferred.has(n));

    expect(
      orphans,
      `These routes are declared and nothing serves them. Add a handler in ` +
      `src/routes/index.ts, or list them in PENDING_ROUTES with the phase ` +
      `they are waiting on: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * A ratchet. Every declared route is served, and this is what keeps it that
   * way.
   *
   * PENDING_ROUTES exists so that a deliberately deferred route is visible
   * rather than a silent 404, and it worked: eight names sat in it across two
   * phases and all eight are now implemented. Empty, it is one line away from
   * becoming a convenient place to park a contract somebody did not finish.
   *
   * Adding a name here again should require editing this test, which makes it
   * a decision with a reviewer rather than an import away.
   */
  it("has nothing deferred", () => {
    expect(
      PENDING_ROUTES,
      `PENDING_ROUTES is empty and should stay that way. If a route genuinely ` +
      `has to ship declared and unserved, say why here as well as there.`,
    ).toEqual([]);
  });

  it("does not defer a route it actually implements", () => {
    const implemented = new Set<string>(Object.keys(handlers));
    const stale = PENDING_ROUTES.filter((n) => implemented.has(n));
    expect(stale, `PENDING_ROUTES still lists routes that are now built: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("does not name a route that no longer exists", () => {
    const real = new Set<string>(routeNames);
    const ghosts = PENDING_ROUTES.filter((n) => !real.has(n));
    expect(ghosts, `PENDING_ROUTES names routes that were removed: ${ghosts.join(", ")}`)
      .toEqual([]);
  });

  /**
   * THE OTHER DIRECTION: A HANDLER NOTHING SERVES.
   *
   * The check above catches a route with no handler, and the compiler catches it
   * too, because the table in `routes/index.ts` is typed against the registry. The
   * reverse has nothing watching it: a service exports `handlers.doTheThing`,
   * nobody adds the line to `routes/index.ts`, and the capability is written,
   * tested and unreachable. That is exactly how the equipment register, the
   * customer lifecycle, the task queue, workflows and inspections ended up on
   * screens with no API behind them, which is the opposite of BUILD.md's third
   * ordering rule.
   *
   * Every key a service exposes as a handler has to be served. A service function
   * that is deliberately internal simply is not in a `handlers` object.
   */
  it("serves every handler a service exposes", () => {
    const served = new Set<string>(Object.keys(handlers));
    const stranded: string[] = [];
    let checked = 0;

    for (const [name, mod] of Object.entries(services as Record<string, unknown>)) {
      if (typeof mod !== "object" || mod === null) continue;
      const table = (mod as { handlers?: unknown }).handlers;
      if (typeof table !== "object" || table === null) continue;
      for (const key of Object.keys(table)) {
        checked += 1;
        if (!served.has(key)) stranded.push(`${name}.handlers.${key}`);
      }
    }

    expect(
      stranded,
      "These handlers exist and nothing serves them. Add the line to "
      + "src/routes/index.ts, or take them out of the handlers object if they are "
      + "internal",
    ).toEqual([]);
    /** And it looked at something, so an import that stopped resolving is not a pass. */
    expect(checked).toBeGreaterThan(200);
  });
});
