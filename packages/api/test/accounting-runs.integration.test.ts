import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, ledger, type Actor } from "@opentradesos/core";
import * as accounting from "../src/services/accounting";
import * as billing from "../src/services/billing";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import type {
  AccountingEntityKind, AccountingProvider, ChangeSet, ExternalRef, PushResult, ReadResult,
} from "../src/accounting/provider";
import "../src/accounting";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";
import { getAccountingRun, listAccountingRuns } from "../src/contracts/accounting";

/**
 * WHAT A SYNC PASS SENT AND REFUSED, AND CLOSING A PERIOD FROM A SCREEN
 *
 * The run history counted reads and writes and nothing else, so "did invoice
 * 1042 go, and if not why not" had no answer short of a database client.
 * Each pass now writes down every document it sent, found already in the
 * books, or refused, with the reason, in the transaction that records the
 * outcome on the document's link. These tests hold the list to what the
 * link table says, and keep out what would bury it: documents already in
 * the books, and documents that have stopped being offered.
 *
 * The period close is driven from a screen now, so the two rules a screen
 * makes easy to trip are tested here: a month reopened by mistake can be
 * closed again, and a day that has not come cannot be closed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("accounting-runs/org");
const USER = fixtureId("accounting-runs/user");
const OTHER_ORG = fixtureId("accounting-runs/other-org");
const OTHER_USER = fixtureId("accounting-runs/other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (organizationId: string, userId: string, roles: string[], grants: string[] = []): ServiceContext => ({
  actor: {
    userId, organizationId,
    roles: roles as Actor["roles"],
    ...(grants.length > 0 ? { grants: grants as NonNullable<Actor["grants"]> } : {}),
  },
  db: db(),
});
const owner = () => as(ORG, USER, ["owner"]);
const otherOwner = () => as(OTHER_ORG, OTHER_USER, ["owner"]);
/** The ledger and the books' screens, and not the sync. */
const withoutSync = () => as(ORG, USER, [], ["ledger:read", "ledger:post", "settings:read", "invoice:read"]);

let customerId = "";

/** Books that take everything, or refuse one kind with a reason, or already hold one document. */
function books(options: {
  refuse?: { kind: AccountingEntityKind; code: string; message: string };
  /** Already over there under this key: a push says duplicate and a lookup finds it. */
  holds?: { kind: AccountingEntityKind; key: string };
} = {}): AccountingProvider {
  let next = 1;
  const push = (kind: AccountingEntityKind, key: string): PushResult => {
    if (options.refuse?.kind === kind) {
      return { ok: false, code: options.refuse.code, message: options.refuse.message, retryable: false, duplicate: false };
    }
    if (options.holds?.kind === kind && options.holds.key === key) {
      return { ok: false, code: "6140", message: "Duplicate Document Number Error", retryable: false, duplicate: true };
    }
    return { ok: true, externalId: `${kind}-${next++}`, version: "0", adopted: false };
  };
  return {
    name: "fake",
    heldMoneyReachesBooks: true,
    async pushCustomer(c) { return push("customer", c.idempotencyKey); },
    async pushInvoice(i) { return push("invoice", i.idempotencyKey); },
    async pushPayment(p) { return push("payment", p.idempotencyKey); },
    async pushCredit(c) { return push("credit_memo", c.idempotencyKey); },
    async pushRefund(r) { return push("refund", r.idempotencyKey); },
    async pushCreditNote(n) { return push("credit_note", n.idempotencyKey); },
    async pushCreditApplication(a) { return push("credit_note_application", a.idempotencyKey); },
    async findCreditApplication(): Promise<ReadResult<ExternalRef | null>> { return { ok: true, value: null }; },
    async findPushed(kind, key): Promise<ReadResult<ExternalRef | null>> {
      const held = options.holds?.kind === kind && options.holds.key === key;
      return { ok: true, value: held ? { externalId: `${kind}-held`, version: "3" } : null };
    },
    async changes(cursor): Promise<ReadResult<ChangeSet>> {
      return { ok: true, value: { cursor: `after-${cursor ?? "start"}`, changes: [], more: false } };
    },
    async accounts() { return { ok: true, value: [] }; },
  };
}

async function mapEverything(): Promise<void> {
  for (const code of [ledger.ACCOUNTS.REVENUE, ledger.ACCOUNTS.TAX_PAYABLE, ledger.ACCOUNTS.CASH, ledger.ACCOUNTS.WRITE_OFF]) {
    await accounting.setMapping(owner(), {
      accountCode: code, externalId: `qbo-${code}`, externalName: `Books ${code}`, externalKind: "Item",
    });
  }
}

async function anInvoice(): Promise<{ id: string; number: number }> {
  const invoice = await billing.create(owner(), {
    customerId,
    lines: [{ name: "Service call", quantity: "1", unitPrice: "250.00", discountAmount: "0", taxable: false }],
  });
  return { id: invoice.id as string, number: invoice.number as number };
}

async function connect(organizationId: string): Promise<string> {
  const [conn] = await raw`
    insert into public.integration_connection
      (organization_id, capability, provider, status, credential_ref, settings)
    values (${organizationId}, 'accounting', 'quickbooks', 'connected', 'TEST_QBO_CREDENTIAL',
            ${raw.json({ realmId: "123" })})
    returning id`;
  return conn!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Runs Co", slug: "accounting-runs-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Runs Co", slug: "accounting-runs-other-co" });

  const [c] = await raw`insert into public.customer (organization_id, name)
    values (${ORG}, 'Okafor Family') returning id`;
  customerId = c!.id as string;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Pecan St', 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${p!.id})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const org of [ORG, OTHER_ORG]) {
    await raw`delete from public.sync_run_document where organization_id = ${org}`;
    await raw`delete from public.accounting_entity_link where organization_id = ${org}`;
    await raw`delete from public.account_mapping where organization_id = ${org}`;
    await raw`delete from public.accounting_period where organization_id = ${org}`;
    await raw`delete from public.sync_run where organization_id = ${org}`;
    await raw`delete from public.integration_connection where organization_id = ${org}`;
  }
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  /** The ledger refuses a DELETE by trigger; suspended for this session's cleanup only, as `resetOrg` does. */
  await raw.unsafe("set session_replication_role = replica");
  try {
    await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
    await raw`delete from public.invoice where organization_id = ${ORG}`;
  } finally {
    await raw.unsafe("set session_replication_role = origin");
  }
  await connect(ORG);
});

run("what a sync pass sent and refused", () => {
  it("writes down each document it sent and each one the books refused, with the books' reason", async () => {
    await mapEverything();
    const invoice = await anInvoice();
    const outcome = await accounting.sync(owner(), {
      provider: books({ refuse: { kind: "invoice", code: "6000", message: "Invalid Reference Id: Item 4000 was deleted" } }),
    });

    const [listed] = await accounting.listRuns(owner());
    expect(listed!.id).toBe(outcome.runId);
    expect({ sent: listed!.sent, found: listed!.found, refused: listed!.refused }).toEqual({ sent: 1, found: 0, refused: 1 });

    const detail = await accounting.runDocuments(owner(), { runId: outcome.runId });
    expect(detail.more).toBe(false);
    /** Refusals first: they are what somebody opened the pass to find. */
    expect(detail.documents.map((d) => [d.kind, d.outcome])).toEqual([["invoice", "refused"], ["customer", "sent"]]);
    expect(detail.documents[0]!.entityId).toBe(invoice.id);
    expect(detail.documents[0]!.idempotencyKey).toBe(String(invoice.number));
    expect(detail.documents[0]!.message).toBe("6000: Invalid Reference Id: Item 4000 was deleted");
    expect(detail.documents[1]!.entityId).toBe(customerId);
    expect(detail.documents[1]!.message).toBeNull();

    /** The route's own shapes hold what the service hands them. */
    expect(() => listAccountingRuns.output.parse({
      runs: [{ ...listed!, startedAt: listed!.startedAt.toISOString(), finishedAt: listed!.finishedAt?.toISOString() ?? null }],
    })).not.toThrow();
    expect(() => getAccountingRun.output.parse({
      ...detail,
      startedAt: detail.startedAt.toISOString(),
      finishedAt: detail.finishedAt?.toISOString() ?? null,
      documents: detail.documents.map((d) => ({ ...d, at: d.at.toISOString() })),
    })).not.toThrow();
  });

  it("writes down a refusal made here before sending, naming the account to map", async () => {
    /** Nothing mapped: the invoice is refused by name and never reaches the books. */
    const invoice = await anInvoice();
    const outcome = await accounting.sync(owner(), { provider: books() });

    const detail = await accounting.runDocuments(owner(), { runId: outcome.runId });
    const refused = detail.documents.find((d) => d.kind === "invoice");
    expect(refused?.outcome).toBe("refused");
    expect(refused?.entityId).toBe(invoice.id);
    expect(refused?.message).toContain(ledger.ACCOUNTS.REVENUE);
  });

  it("lists nothing for a pass that found everything already in the books", async () => {
    await mapEverything();
    await anInvoice();
    const first = await accounting.sync(owner(), { provider: books() });
    const second = await accounting.sync(owner(), { provider: books() });

    expect(first.pushed).toBe(2);
    const detail = await accounting.runDocuments(owner(), { runId: second.runId });
    expect(detail.documents).toEqual([]);
    const [listed] = await accounting.listRuns(owner());
    expect({ sent: listed!.sent, found: listed!.found, refused: listed!.refused }).toEqual({ sent: 0, found: 0, refused: 0 });
  });

  it("says a document the books already held was found, not sent", async () => {
    await mapEverything();
    const invoice = await anInvoice();
    const outcome = await accounting.sync(owner(), {
      provider: books({ holds: { kind: "invoice", key: String(invoice.number) } }),
    });

    const detail = await accounting.runDocuments(owner(), { runId: outcome.runId });
    expect(detail.documents.find((d) => d.kind === "invoice")?.outcome).toBe("found");
    const [link] = await raw<{ state: string; external_id: string }[]>`
      select state, external_id from public.accounting_entity_link
      where organization_id = ${ORG} and kind = 'invoice'`;
    expect(link).toEqual({ state: "linked", external_id: "invoice-held" });
  });

  it("leaves out a document that has stopped being offered", async () => {
    /** It is on the problems list; writing it into every pass would bury what each pass did. */
    const invoice = await anInvoice();
    for (let pass = 0; pass < accounting.MAX_ATTEMPTS; pass += 1) {
      await accounting.sync(owner(), { provider: books() });
    }
    const last = await accounting.sync(owner(), { provider: books() });
    const detail = await accounting.runDocuments(owner(), { runId: last.runId });
    expect(detail.documents.filter((d) => d.entityId === invoice.id)).toEqual([]);

    const refusals = await raw<{ n: number }[]>`
      select count(*)::int as n from public.sync_run_document
      where organization_id = ${ORG} and entity_id = ${invoice.id} and outcome = 'refused'`;
    expect(refusals[0]!.n).toBe(accounting.MAX_ATTEMPTS);
  });

  it("needs accounting:sync, and shows one company's pass to nobody else", async () => {
    await mapEverything();
    await anInvoice();
    const outcome = await accounting.sync(owner(), { provider: books() });

    await expect(accounting.runDocuments(withoutSync(), { runId: outcome.runId })).rejects.toThrow(PermissionError);
    await expect(accounting.listRuns(withoutSync())).rejects.toThrow(PermissionError);

    await connect(OTHER_ORG);
    await expect(accounting.runDocuments(otherOwner(), { runId: outcome.runId })).rejects.toThrow(NotFoundError);
    expect(await accounting.listRuns(otherOwner())).toEqual([]);
  });
});

run("closing a period, as the screen does it", () => {
  it("closes again a period that was reopened, keeping the reopened close on the record", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2026-01-31", note: "January filed." });
    await accounting.reopenPeriod(owner(), { periodEnd: "2026-01-31", reason: "A bill came in late." });
    const again = await accounting.closePeriod(owner(), { periodEnd: "2026-01-31", note: "January filed again." });

    const periods = await accounting.listPeriods(owner());
    expect(periods).toHaveLength(2);
    expect(periods.filter((p) => p.reopenedAt === null).map((p) => p.id)).toEqual([again.id]);
    expect(periods.find((p) => p.reopenedAt !== null)?.reopenedReason).toBe("A bill came in late.");
    expect(await accounting.status(owner()).then((s) => s.closedThrough)).toBe("2026-01-31");
  });

  it("refuses a day that has not come yet, and takes today", async () => {
    /** The company's day, so a Texas evening is not tomorrow. */
    await expect(accounting.closePeriod(owner(), { periodEnd: companyToday(1) }))
      .rejects.toThrow(/has not come yet/);
    await expect(accounting.closePeriod(owner(), { periodEnd: companyToday(1) })).rejects.toThrow(ConflictError);
    const closed = await accounting.closePeriod(owner(), { periodEnd: companyToday() });
    expect(closed.periodEnd).toBe(companyToday());
  });

  it("still refuses to close backwards, in words", async () => {
    await accounting.closePeriod(owner(), { periodEnd: "2026-03-31" });
    await expect(accounting.closePeriod(owner(), { periodEnd: "2026-02-28" }))
      .rejects.toThrow("The books are already closed through 2026-03-31, which is on or after 2026-02-28.");
  });
});
