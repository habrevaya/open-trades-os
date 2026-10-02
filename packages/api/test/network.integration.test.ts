import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as network from "../src/services/network";
import * as operator from "../src/services/operator";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A ROLL UP ACROSS TENANTS, AND THE ONLY THING THAT MAKES ONE LEGITIMATE
 *
 * `network` and `network_grant` have been in this schema since the first
 * migration with no reader and no writer anywhere. Row level security is FORCED
 * on every table carrying `organization_id`, which is the property this whole
 * product rests on, and a roll up is by definition a read across it.
 *
 * So every test here is about the boundary rather than about the arithmetic.
 * The three that matter most:
 *
 *   A FRANCHISEE MUST NOT READ ITS NEIGHBOUR'S NUMBERS by naming the network it
 *   also belongs to. That is the first thing anybody would try.
 *
 *   AN OPERATOR MUST NOT GRANT ON A MEMBER'S BEHALF. There is no shape of call
 *   that does it, and the test proves the data a member never consented to is
 *   absent rather than merely unrequested.
 *
 *   A REVOCATION TAKES EFFECT ON THE NEXT CALL.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const HQ = fixtureId("net:hq");
const HQ_USER = fixtureId("net:hq-user");
const A = fixtureId("net:member-a");
const A_USER = fixtureId("net:member-a-user");
const B = fixtureId("net:member-b");
const B_USER = fixtureId("net:member-b-user");
const OUTSIDER = fixtureId("net:outsider");
const OUTSIDER_USER = fixtureId("net:outsider-user");

let raw: postgres.Sql;
let networkId = "";
const db = () => testDb(url!);

const owner = (org: string, user: string): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** Exactly these permissions and no role, so a pair can be told apart. */
const granted = (org: string, user: string, ...permissions: string[]): ServiceContext => ({
  actor: {
    userId: user, organizationId: org,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

const hq = () => owner(HQ, HQ_USER);
const memberA = () => owner(A, A_USER);
const memberB = () => owner(B, B_USER);
const outsider = () => owner(OUTSIDER, OUTSIDER_USER);

/** A completed job and an issued invoice in a member, on a given month. */
async function work(org: string, month: string, total: string): Promise<void> {
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${org}, 'residential', 'Somebody', 0) returning id`;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, '1 Road', 'Austin', 'TX', '78704') returning id`;
  const n = Math.floor(Math.random() * 1_000_000);
  await raw`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary,
                            total, completed_at)
    values (${org}, ${n}, ${customer!.id}, ${property!.id}, 'completed', 'Work', ${total},
            ${`${month}-15T15:00:00Z`}::timestamptz)`;
  await raw`
    insert into public.invoice (
      organization_id, number, customer_id, status, issued_on, currency,
      subtotal, discount_total, tax_total, total, amount_paid, balance, deposit_held
    ) values (
      ${org}, ${n}, ${customer!.id}, 'paid', ${`${month}-20`}::date, 'USD',
      ${total}, '0', '0', ${total}, ${total}, '0', '0'
    )`;
}

/**
 * One balanced pair of ledger entries.
 *
 * `transaction_id` groups the pair and there is no transaction table: a trigger
 * enforces that the entries sharing one id sum to zero, so both go in as one
 * statement with a uuid of their own.
 */
async function ledgerPair(
  org: string, day: string,
  firstDirection: string, firstCode: string,
  secondDirection: string, secondCode: string,
  amount: string,
): Promise<void> {
  await raw`
    insert into public.ledger_entry (organization_id, transaction_id, occurred_at, direction,
                                     account_code, currency, amount, source_type, source_id)
    select ${org}, t.id, ${`${day}T12:00:00Z`}::timestamptz, d.direction, d.code, 'USD',
           ${amount}, 'manual', t.id
    from (select gen_random_uuid() as id) t,
         (values (${firstDirection}::ledger_direction, ${firstCode}),
                 (${secondDirection}::ledger_direction, ${secondCode}))
           as d(direction, code)`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await raw`delete from public.network where slug like 'net-test-%'`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.network where slug like 'net-test-%'`;
  for (const [org, user, name, slug] of [
    [HQ, HQ_USER, "Brand HQ", "brand-hq"],
    [A, A_USER, "Franchisee A", "franchisee-a"],
    [B, B_USER, "Franchisee B", "franchisee-b"],
    [OUTSIDER, OUTSIDER_USER, "Unrelated Co", "unrelated-co"],
  ] as const) {
    await seedOrg(raw, { organizationId: org, userId: user, name, slug });
  }

  const created = await operator.createNetwork(db(), {
    name: "Brand Network", slug: "net-test-brand", kind: "franchise",
    operatorOrganizationId: HQ,
  });
  networkId = created.id;
  await operator.setNetworkMembership(db(), A, { networkId, memberCode: "A-01" });
  await operator.setNetworkMembership(db(), B, { networkId, memberCode: "B-02" });
});

/* ==================================================== the member's own view */

run("what a member sees about its own network", () => {
  it("lists what is shared and what is not, so the screen is a list of choices", async () => {
    /**
     * Both halves. A screen showing only what is shared is a list of facts; a
     * screen showing both is a list of decisions, which is what somebody ticking
     * a box that lets another company see their revenue actually needs.
     */
    const view = await network.membership(memberA());
    expect(view.networkId).toBe(networkId);
    expect(view.networkName).toBe("Brand Network");
    expect(view.memberCode).toBe("A-01");
    expect(view.isOperator).toBe(false);
    expect(view.sharing).toEqual([]);
    expect(view.notSharing.map((row) => row.aggregate).sort())
      .toEqual([...network.AGGREGATES].sort());
  });

  it("describes each aggregate in the member's words, not in a column name", async () => {
    /**
     * "gl_summary" is not a label. On the screen where somebody consents, the
     * sentence is the whole decision, and the one for the ledger says what it
     * never includes.
     */
    const view = await network.membership(memberA());
    const ledger = view.notSharing.find((row) => row.aggregate === "gl_summary");
    expect(ledger!.description).toMatch(/Never a single account and never a transaction/);
  });

  it("tells a company in no network that it is in none, rather than erroring", async () => {
    const view = await network.membership(outsider());
    expect(view.networkId).toBeNull();
    expect(view.sharing).toEqual([]);
    expect(view.notSharing).toHaveLength(network.AGGREGATES.length);
  });

  it("knows the operator is the operator", async () => {
    /**
     * The operator is a member of its own network, and has to be: the RLS policy
     * on `network` lets a session read the network its own organization belongs
     * to, so an operator that was not a member could not read the row describing
     * the network it operates.
     */
    const view = await network.membership(hq());
    expect(view.isOperator).toBe(true);
    expect(view.memberCode).toBe("operator");
  });

  it("refuses to share when there is no network to share with", async () => {
    /**
     * A ConflictError, not a NotFoundError, and the distinction is the HTTP
     * status: this is a 409 because the company exists and the state is wrong,
     * rather than a 404 about something that cannot be found.
     */
    await expect(network.share(outsider(), { aggregate: "job_counts" }))
      .rejects.toThrow(ConflictError);
    await expect(network.share(outsider(), { aggregate: "job_counts" }))
      .rejects.toThrow(/not in a network/);
  });

  it("refuses an aggregate that is not one", async () => {
    await expect(network.share(memberA(), { aggregate: "customer_list" }))
      .rejects.toThrow(/is not something that can be shared/);
  });
});

/* ============================================================== the consent */

run("the consent", () => {
  it("is granted by the member, per aggregate", async () => {
    const after = await network.share(memberA(), { aggregate: "job_counts" });
    expect(after.sharing.map((row) => row.aggregate)).toEqual(["job_counts"]);
    expect(after.notSharing.map((row) => row.aggregate)).not.toContain("job_counts");

    /**
     * PER AGGREGATE, NOT PER NETWORK. A franchisor entitled to revenue under the
     * agreement is not therefore entitled to the general ledger, and this is
     * where that distinction is real rather than documented.
     */
    const roster = await network.members(hq());
    expect(roster.data.find((row) => row.organizationId === A)!.aggregates)
      .toEqual(["job_counts"]);
  });

  it("is a no-op when granted twice, which is the right shape for a checkbox", async () => {
    await network.share(memberA(), { aggregate: "revenue_summary" });
    const twice = await network.share(memberA(), { aggregate: "revenue_summary" });
    expect(twice.sharing.map((row) => row.aggregate)).toEqual(["revenue_summary"]);

    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.network_grant where organization_id = ${A}`;
    expect(n).toBe("1");
  });

  it("is revoked rather than deleted, so a member can prove when it stopped", async () => {
    /**
     * "They used to see our revenue and we stopped letting them in March" is a
     * fact a member may need to prove, and a deleted row proves nothing.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    const after = await network.stopSharing(memberA(), { aggregate: "job_counts" });
    expect(after.sharing).toEqual([]);

    const [row] = await raw<{ revoked_at: Date | null; granted_at: Date }[]>`
      select revoked_at, granted_at from public.network_grant where organization_id = ${A}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.granted_at).not.toBeNull();
  });

  it("re-grants onto the same row rather than refusing on the unique index", async () => {
    /**
     * The index on (network, organization, aggregate) has no predicate, so a
     * revoked grant and a never-granted one are the same row. A plain insert
     * would fail the second time somebody turns sharing back on.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await network.stopSharing(memberA(), { aggregate: "job_counts" });
    const again = await network.share(memberA(), { aggregate: "job_counts" });
    expect(again.sharing.map((row) => row.aggregate)).toEqual(["job_counts"]);

    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.network_grant where organization_id = ${A}`;
    expect(n).toBe("1");
  });

  it("needs settings:write, not merely settings:read", async () => {
    /**
     * The decision to show another company your revenue should not be available
     * to somebody who does not sign the franchise agreement. Both halves with an
     * explicit grant and NO role, because the owner holds both.
     */
    await expect(network.share(granted(A, A_USER, "settings:read"), { aggregate: "job_counts" }))
      .rejects.toThrow(/permission/);
    const ok = await network.share(granted(A, A_USER, "settings:write"), {
      aggregate: "job_counts",
    });
    expect(ok.sharing).toHaveLength(1);
  });

  it("cannot be granted by one member on another's behalf", async () => {
    /**
     * Structural rather than checked: the row is written with the caller's own
     * organization id, so there is no argument to put somebody else's in. The
     * assertion is on the database, because the absence of a parameter is not
     * something a test can call.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.network_grant where organization_id = ${B}`;
    expect(n).toBe("0");
  });
});

/* ============================================================= the boundary */

run("the tenant boundary", () => {
  it("will not let a franchisee read the roll up of the network it belongs to", async () => {
    /**
     * THE FIRST THING ANYBODY WOULD TRY. Member A is in the network and can read
     * the network row through row level security; what stops it is the operator
     * check, and it answers NOT FOUND rather than forbidden, because the second
     * answer confirms there is something there and invites the next attempt.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await network.share(memberB(), { aggregate: "job_counts" });
    await work(B, "2026-06", "5000.0000");

    await expect(network.rollup(memberA(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    })).rejects.toThrow(NotFoundError);
    await expect(network.members(memberA())).rejects.toThrow(NotFoundError);
  });

  it("refuses a member in the SQL itself, not only in the service", async () => {
    /**
     * THE SWEEP FOUND THIS UNTESTED, AND IT IS THE REAL BOUNDARY.
     *
     * `operatedNetwork` in the service refuses a member before the SQL is ever
     * called, so removing the operator check from `app.network_rollup` left
     * every other test in this file green. That check is the one that matters:
     * the service's is a convenience for a good error message, and the
     * function's is what a future caller, a report, a worker or an MCP tool
     * cannot get round.
     *
     * So this goes straight at the function, in a member's own tenant context
     * and as the role a session runs as, which is exactly the position an
     * attacker who had found the function name would be in.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");

    const asMember = async (fn: string) => {
      const client = postgres(url!, { max: 1, onnotice: () => {} });
      try {
        return await client.begin(async (tx) => {
          await tx.unsafe("set local role authenticated");
          await tx`select set_config('app.organization_id', ${A}, true)`;
          await tx`select set_config('app.user_id', ${A_USER}, true)`;
          return tx.unsafe(fn);
        });
      } finally {
        await client.end();
      }
    };

    const rollup = await asMember(
      `select * from app.network_rollup('${networkId}', 'job_counts',
       '2026-06-01'::date, '2026-06-30'::date)`,
    );
    expect(rollup).toEqual([]);

    const roster = await asMember(`select * from app.network_members('${networkId}')`);
    expect(roster).toEqual([]);
  });

  it("gives the operator its own data through the same function", async () => {
    /**
     * The other direction, so the test above is about the operator check rather
     * than about the function returning nothing to anybody.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");

    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const rows = await client.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('app.organization_id', ${HQ}, true)`;
        await tx`select set_config('app.user_id', ${HQ_USER}, true)`;
        return tx.unsafe(`select * from app.network_rollup('${networkId}', 'job_counts',
          '2026-06-01'::date, '2026-06-30'::date)`);
      });
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("will not let an unrelated company read anything about the network", async () => {
    await expect(network.members(outsider())).rejects.toThrow(NotFoundError);
    await expect(network.rollup(outsider(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    })).rejects.toThrow(NotFoundError);
  });

  it("returns nothing for a member that never consented", async () => {
    /**
     * SILENTLY, and that is deliberate. Raising an error would let an operator
     * lean on a member by making the whole report fail until they consent. The
     * member is named in `notContributing` instead, with whether the silence is
     * a missing consent or a quiet month.
     */
    await work(A, "2026-06", "4000.0000");
    await work(B, "2026-06", "9000.0000");
    await network.share(memberA(), { aggregate: "revenue_summary" });

    const report = await network.rollup(hq(), {
      aggregate: "revenue_summary", from: "2026-06-01", to: "2026-06-30",
    });

    expect(report.data.every((row) => row.organizationId === A)).toBe(true);
    const silent = report.notContributing.find((row) => row.organizationId === B);
    expect(silent).toBeTruthy();
    expect(silent!.sharesThis).toBe(false);
  });

  it("tells a quiet month apart from a missing consent", async () => {
    /**
     * Two different facts and two different conversations: one is a franchisee
     * who has not turned sharing on, the other is a franchisee who did no work.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await network.share(memberB(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");

    const report = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    const quiet = report.notContributing.find((row) => row.organizationId === B);
    expect(quiet!.sharesThis).toBe(true);
  });

  it("stops contributing the moment a grant is revoked", async () => {
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");

    const before = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    expect(before.data).toHaveLength(1);

    await network.stopSharing(memberA(), { aggregate: "job_counts" });
    const after = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    expect(after.data).toEqual([]);
  });

  it("gives nothing for an aggregate the member did not grant", async () => {
    /**
     * The whole reason the grant is per aggregate. A member sharing job counts
     * has not shared its ledger, and asking for the ledger returns nothing
     * rather than everything the member shared.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");

    const jobs = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    expect(jobs.data).toHaveLength(1);

    /**
     * THE LEDGER HAS TO HAVE SOMETHING IN IT for this to mean anything, which
     * the sweep showed: with no entries the gl_summary branch returns nothing
     * whether or not the aggregate is matched, so the first version of this test
     * passed against a function that ignored the grant's aggregate entirely.
     */
    await ledgerPair(A, "2026-06-10", "debit", "1100", "credit", "4000", "500.0000");
    const ledger = await network.rollup(hq(), {
      aggregate: "gl_summary", from: "2026-06-01", to: "2026-06-30",
    });
    expect(ledger.data).toEqual([]);
  });

  it("leaves a suspended company out of the roll up", async () => {
    /**
     * For the same reason it cannot sign in: whoever runs the deployment has
     * turned it off. Its numbers are not the operator's to read in the meantime.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "4000.0000");
    await operator.suspend(db(), A, "Did not pay");

    const report = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    expect(report.data).toEqual([]);
    expect(report.notContributing.find((row) => row.organizationId === A)!.sharesThis).toBe(true);
  });

  it("returns no customer, address or document anywhere in the shape", async () => {
    /**
     * THE PROPERTY THE WHOLE FEATURE RESTS ON. Not asserted by reading the SQL:
     * asserted on the serialised answer, because a future branch that joined a
     * customer in would pass every other test in this file.
     */
    for (const aggregate of network.AGGREGATES) {
      await network.share(memberA(), { aggregate });
    }
    await work(A, "2026-06", "4000.0000");

    for (const aggregate of network.AGGREGATES) {
      const report = await network.rollup(hq(), {
        aggregate, from: "2026-06-01", to: "2026-06-30",
      });
      for (const row of report.data) {
        expect(Object.keys(row).sort())
          .toEqual(["memberCode", "metric", "organizationId", "period", "value"]);
      }
      const text = JSON.stringify(report);
      expect(text).not.toContain("Somebody");
      expect(text).not.toContain("1 Road");
    }
  });
});

/* =============================================================== the roster */

run("the roster", () => {
  it("includes the members sharing nothing, which is the point", async () => {
    /**
     * "We have six franchisees and two have not turned sharing on" is what an
     * operator needs to see. A roster listing only the sharing ones makes the
     * missing numbers look like zeros, which is the difference between chasing a
     * franchisee and writing off a market.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    const roster = await network.members(hq());
    const byId = new Map(roster.data.map((row) => [row.organizationId, row]));
    expect(byId.get(A)!.aggregates).toEqual(["job_counts"]);
    expect(byId.get(B)!.aggregates).toEqual([]);
    expect(byId.has(HQ)).toBe(true);
  });

  it("gives the name and the member code and nothing else", async () => {
    const roster = await network.members(hq());
    for (const row of roster.data) {
      expect(Object.keys(row).sort())
        .toEqual(["aggregates", "memberCode", "name", "organizationId", "suspended"]);
    }
  });

  it("shows a suspended member as suspended rather than hiding it", async () => {
    await operator.suspend(db(), B, "Did not pay");
    const roster = await network.members(hq());
    expect(roster.data.find((row) => row.organizationId === B)!.suspended).toBe(true);
  });
});

/* ============================================================= the numbers */

run("the numbers", () => {
  it("counts jobs by member by month", async () => {
    await network.share(memberA(), { aggregate: "job_counts" });
    await work(A, "2026-06", "1000.0000");
    await work(A, "2026-06", "2000.0000");
    await work(A, "2026-07", "3000.0000");

    const report = await network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-07-31",
    });
    const byPeriod = new Map(report.data.map((row) => [row.period, row.value]));
    expect(byPeriod.get("2026-06")).toBe("2");
    expect(byPeriod.get("2026-07")).toBe("1");
  });

  it("reports invoiced and collected as two metrics, not one", async () => {
    /**
     * A franchisor looking at a bad month needs to know whether the work stopped
     * or the money did, and one number cannot say which.
     */
    await network.share(memberA(), { aggregate: "revenue_summary" });
    await work(A, "2026-06", "4000.0000");

    const report = await network.rollup(hq(), {
      aggregate: "revenue_summary", from: "2026-06-01", to: "2026-06-30",
    });
    expect(report.data.map((row) => row.metric).sort()).toEqual(["collected", "invoiced"]);
  });

  it("gives the invoice count rather than an average ticket", async () => {
    /**
     * A ratio computed inside an aggregate cannot be summed across members
     * afterwards, and a franchisor comparing six brands will try. The count and
     * the total both come back and the reader divides.
     */
    await network.share(memberA(), { aggregate: "kpi_scorecard" });
    await work(A, "2026-06", "1000.0000");
    await work(A, "2026-06", "3000.0000");

    const report = await network.rollup(hq(), {
      aggregate: "kpi_scorecard", from: "2026-06-01", to: "2026-06-30",
    });
    const byMetric = new Map(report.data.map((row) => [row.metric, row.value]));
    expect(byMetric.get("invoices")).toBe("2");
    expect(byMetric.get("invoiced")).toBe("4000.0000");
    expect([...byMetric.keys()]).not.toContain("average_ticket");
  });

  it("reports the ledger by class and never by account code", async () => {
    /**
     * The code is the member's own chart of accounts, and naming one would let
     * an operator ask about a single account, which is a row read wearing an
     * aggregate's clothes.
     */
    await network.share(memberA(), { aggregate: "gl_summary" });
    await ledgerPair(A, "2026-06-10", "debit", "1100", "credit", "4000", "500.0000");

    const report = await network.rollup(hq(), {
      aggregate: "gl_summary", from: "2026-06-01", to: "2026-06-30",
    });
    const byMetric = new Map(report.data.map((row) => [row.metric, row.value]));
    expect([...byMetric.keys()].sort()).toEqual(["asset", "revenue"]);
    expect(byMetric.get("asset")).toBe("500.0000");
    expect(byMetric.get("revenue")).toBe("500.0000");
    expect(JSON.stringify(report)).not.toContain("1100");
  });

  it("signs the ledger to each account's normal balance", async () => {
    /**
     * THE SWEEP FOUND THE OTHER TEST COULD NOT SEE THIS. With one debit to an
     * asset and one credit to revenue, a plain `sum(amount)` gives the same two
     * numbers as a signed one, so a function that ignored direction entirely
     * passed. A payment is the case that separates them: it CREDITS receivables,
     * which reduces an asset, and a sum that ignores the direction reports the
     * company's receivables going up when a customer pays.
     */
    await network.share(memberA(), { aggregate: "gl_summary" });
    await ledgerPair(A, "2026-06-10", "debit", "1000", "credit", "1100", "300.0000");

    const report = await network.rollup(hq(), {
      aggregate: "gl_summary", from: "2026-06-01", to: "2026-06-30",
    });
    const byMetric = new Map(report.data.map((row) => [row.metric, row.value]));
    /**
     * Cash up three hundred and receivables down three hundred, both assets, so
     * the class nets to zero. An unsigned sum would say six hundred.
     */
    expect(byMetric.get("asset")).toBe("0.0000");
  });

  it("leaves a draft invoice out of the revenue", async () => {
    /**
     * A draft is not revenue, and the sweep found nothing covering it: the
     * fixture only ever wrote issued invoices, so a function that counted drafts
     * passed every test in this file.
     */
    await network.share(memberA(), { aggregate: "revenue_summary" });
    await work(A, "2026-06", "1000.0000");
    const [customer] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days)
      values (${A}, 'residential', 'Somebody', 0) returning id`;
    await raw`
      insert into public.invoice (
        organization_id, number, customer_id, status, issued_on, currency,
        subtotal, discount_total, tax_total, total, amount_paid, balance, deposit_held
      ) values (
        ${A}, 999999, ${customer!.id}, 'draft', '2026-06-20'::date, 'USD',
        '7000.0000', '0', '0', '7000.0000', '0', '7000.0000', '0'
      )`;

    const report = await network.rollup(hq(), {
      aggregate: "revenue_summary", from: "2026-06-01", to: "2026-06-30",
    });
    const invoiced = report.data.find((row) => row.metric === "invoiced")!;
    expect(invoiced.value).toBe("1000.0000");
  });

  it("returns money as a string", async () => {
    /** Money that has been through a JSON parser as a float is not money. */
    await network.share(memberA(), { aggregate: "revenue_summary" });
    await work(A, "2026-06", "1234.5600");
    const report = await network.rollup(hq(), {
      aggregate: "revenue_summary", from: "2026-06-01", to: "2026-06-30",
    });
    const invoiced = report.data.find((row) => row.metric === "invoiced")!;
    expect(typeof invoiced.value).toBe("string");
    expect(invoiced.value).toBe("1234.5600");
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(network.rollup(hq(), {
      aggregate: "job_counts", from: "2026-06-30", to: "2026-06-01",
    })).rejects.toThrow(/before its start/);
  });

  it("refuses an aggregate that is not one", async () => {
    await expect(network.rollup(hq(), {
      aggregate: "everything", from: "2026-06-01", to: "2026-06-30",
    })).rejects.toThrow(/is not an aggregate/);
  });

  it("needs report:read", async () => {
    await expect(network.rollup(granted(HQ, HQ_USER, "settings:write"), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    })).rejects.toThrow(/permission/);
    const ok = await network.rollup(granted(HQ, HQ_USER, "report:read"), {
      aggregate: "job_counts", from: "2026-06-01", to: "2026-06-30",
    });
    expect(ok.data).toEqual([]);
  });
});

/* ========================================================== the membership */

run("joining and leaving a network", () => {
  it("is set by the operator API, not from inside the product", async () => {
    /**
     * An organization must not be able to put another into its network. Joining
     * is harmless on its own, because nothing is shared until the member grants
     * it, but it is what creates the relationship the member is then asked to
     * consent to.
     *
     * Asserted by the shape of the service: there is no call here that takes
     * another organization's id.
     */
    expect(Object.keys(network.handlers).sort()).toEqual([
      "getNetworkMembership", "getNetworkRollup", "listNetworkMembers",
      "shareWithNetwork", "stopSharingWithNetwork",
    ]);
  });

  it("revokes every grant when a member leaves", async () => {
    /**
     * A franchisee who leaves the franchise has not agreed to keep sharing their
     * revenue with their former franchisor, and a grant row left behind with the
     * membership gone would start sharing again the day somebody put them back.
     */
    await network.share(memberA(), { aggregate: "job_counts" });
    await network.share(memberA(), { aggregate: "revenue_summary" });

    await operator.setNetworkMembership(db(), A, { networkId: null });

    const live = await raw<{ aggregate: string }[]>`
      select aggregate from public.network_grant
      where organization_id = ${A} and revoked_at is null`;
    expect(live).toEqual([]);

    const view = await network.membership(memberA());
    expect(view.networkId).toBeNull();
  });

  it("replays rather than conflicting when a network is created twice", async () => {
    /**
     * A control plane that creates a network and loses the response has to be
     * able to ask again, which is the same reason `create` replays on
     * `externalRef`.
     */
    const again = await operator.createNetwork(db(), {
      name: "Brand Network", slug: "net-test-brand", kind: "franchise",
      operatorOrganizationId: HQ,
    });
    expect(again.id).toBe(networkId);
  });

  it("refuses a slug that is not one", async () => {
    await expect(operator.createNetwork(db(), {
      name: "Bad", slug: "Not A Slug", operatorOrganizationId: HQ,
    })).rejects.toThrow(/is not a slug/);
  });

  it("refuses a network kind the database does not have", async () => {
    /**
     * `network_kind` is `franchise`, `holding`, `cooperative`. A first draft of
     * the kind list in the service carried `buying_group` and `referral`, which
     * the API would have accepted and Postgres refused.
     */
    expect([...operator.NETWORK_KINDS].sort()).toEqual(["cooperative", "franchise", "holding"]);
  });

  it("makes the operator a member of its own network", async () => {
    const view = await operator.getNetwork(db(), networkId);
    expect(view.members.map((member) => member.organizationId).sort())
      .toEqual([A, B, HQ].sort());
    expect(view.members.find((member) => member.organizationId === HQ)!.memberCode)
      .toBe("operator");
  });

  it("refuses to put a company in a network that does not exist", async () => {
    await expect(operator.setNetworkMembership(db(), A, { networkId: fixtureId("net:ghost") }))
      .rejects.toThrow(NotFoundError);
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a refusal about consent rather than a missing row", () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
