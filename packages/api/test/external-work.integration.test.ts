import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { externalWork as ew } from "@opentradesos/core";
import * as externalWork from "../src/services/external-work";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WORKING SOMEBODY ELSE'S QUEUE
 *
 * `external_work_order` was written in the first migrations and reached by
 * nothing: the last table in this schema described in detail and never touched.
 * Its own comment says what the hard part is, and every test here is about that
 * sentence rather than about CRUD:
 *
 *   "THE EXTERNAL SYSTEM IS THE SYSTEM OF RECORD. A local edit that conflicts
 *   loses or escalates."
 *
 * The four properties that matter:
 *
 *   A repeat from their queue must not reset what we have done.
 *   Some networks make acceptance final, and some have no accept call at all.
 *   `cancelled_by_client` and `reopened` are not ours to declare.
 *   A contradiction is not a merge: theirs wins and ours is written down.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("exw:org");
const USER = fixtureId("exw:user");
const OTHER_ORG = fixtureId("exw:other-org");
const OTHER_USER = fixtureId("exw:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const other = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
});
/** Exactly these permissions and no role, so a pair can be told apart. */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let seq = 0;
let customerId = "";
let propertyId = "";

async function job(): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', 'Facilities call')
    returning id`;
  return row!.id;
}

async function invoice(): Promise<string> {
  seq += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.invoice (
      organization_id, number, customer_id, status, issued_on, currency,
      subtotal, discount_total, tax_total, total, amount_paid, balance, deposit_held
    ) values (
      ${ORG}, ${seq}, ${customerId}, 'open', current_date, 'USD',
      '400.0000', '0', '0', '400.0000', '0', '400.0000', '0'
    ) returning id`;
  return row!.id;
}

/** An order from a network, with whatever flags the test needs. */
async function order(over: Partial<externalWork.ReceiveInput> = {}) {
  seq += 1;
  return externalWork.receive(owner(), {
    sourceSystem: "corrigo",
    externalId: `WO-${seq}`,
    externalNumber: `1000${seq}`,
    externalStatus: "New",
    ...over,
  });
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Vendor Co", slug: "vendor-co" });
  await seedOrg(raw, {
    organizationId: OTHER_ORG, userId: OTHER_USER, name: "Rival Vendor", slug: "rival-vendor",
  });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'commercial', 'Facilities Network', 30) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, 'Store 412', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
});

/* ============================================================== the mirror */

run("mirroring an inbound order", () => {
  it("arrives as offered and nothing else", async () => {
    /**
     * A sync that could create an order already accepted would let a middleware
     * bug accept work on a contractor's behalf, and the first anybody would know
     * is a missed appointment.
     */
    const mirrored = await order();
    expect(mirrored.state).toBe("offered");
    expect(mirrored.pendingPush).toBe(false);
    expect(mirrored.externalStatus).toBe("New");
  });

  it("is idempotent on the network's own id", async () => {
    /**
     * They retry, they replay a queue after an outage, and they send the same
     * order to several vendors and tell the losers later. A repeat is the
     * ordinary case rather than an error.
     */
    const first = await externalWork.receive(owner(), {
      sourceSystem: "corrigo", externalId: "WO-SAME",
    });
    const again = await externalWork.receive(owner(), {
      sourceSystem: "corrigo", externalId: "WO-SAME", externalStatus: "Dispatched",
    });
    expect(again.id).toBe(first.id);
    expect(again.externalStatus).toBe("Dispatched");

    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.external_work_order
      where organization_id = ${ORG}`;
    expect(n).toBe("1");
  });

  it("does not reset what we have already done when their queue replays", async () => {
    /**
     * THE SHARP ONE. An order we accepted and started does not go back to offered
     * because their queue replayed, and a resync that reset the state would put
     * work a technician is doing back in the inbox.
     */
    const mirrored = await order({ externalId: "WO-REPLAY" });
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.move(owner(), { id: mirrored.id, to: "in_progress" });

    const replayed = await externalWork.receive(owner(), {
      sourceSystem: "corrigo", externalId: "WO-REPLAY", externalStatus: "New",
    });
    expect(replayed.state).toBe("in_progress");
    /** Their word still updates, because it is theirs. */
    expect(replayed.externalStatus).toBe("New");
  });

  it("refuses an order with no network or no id of theirs", async () => {
    await expect(externalWork.receive(owner(), { sourceSystem: "  ", externalId: "X" }))
      .rejects.toThrow(/needs the network it came from/);
    await expect(externalWork.receive(owner(), { sourceSystem: "corrigo", externalId: " " }))
      .rejects.toThrow(/needs the network it came from/);
  });

  it("takes the network's own defaults for its flags", async () => {
    /**
     * A home warranty administrator's acceptance is final and a dealer network
     * has no accept call. Both are on the row because they differ per network,
     * and defaulting them from the profile is what stops a contractor finding out
     * by clicking.
     */
    const warranty = await order({ sourceSystem: "ahs", externalId: "CLAIM-1" });
    expect(warranty.acceptanceIsIrreversible).toBe(true);

    const dealer = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-1" });
    expect(dealer.acceptsViaInvoiceOnly).toBe(true);
  });

  it("is cautious about a network it has never heard of", async () => {
    /**
     * `source_system` is text because a contractor works whichever networks their
     * market has, and a regional warranty administrator nobody here has heard of
     * is as real as Corrigo. The defaults for one are the safest of each: the
     * cost of assuming acceptance can be undone when it cannot is a chargeback,
     * and of assuming it cannot when it can is one phone call.
     */
    const unknown = await order({ sourceSystem: "regional-warranty-co", externalId: "X-1" });
    expect(unknown.acceptanceIsIrreversible).toBe(true);
    expect(unknown.acceptsViaInvoiceOnly).toBe(false);
    expect(unknown.sourceLabel).toBe("regional-warranty-co");
  });

  it("keeps their whole message, which is what survives their schema changing", async () => {
    const mirrored = await order({
      externalId: "WO-PAYLOAD",
      payload: { nte: "500.00", trade: "HVAC", priority: "P2", theirOwnField: 42 },
    });
    expect(mirrored.payload["nte"]).toBe("500.00");
    expect(mirrored.payload["theirOwnField"]).toBe(42);
  });
});

/* ========================================================== our decisions */

run("what we may do", () => {
  it("accepts an order and links the job it is being done as", async () => {
    const mirrored = await order();
    const jobId = await job();
    const accepted = await externalWork.move(owner(), {
      id: mirrored.id, to: "accepted", jobId,
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.jobId).toBe(jobId);
    /** And we now owe the client an update. */
    expect(accepted.pendingPush).toBe(true);
  });

  it("will not let a declined order carry a job", async () => {
    /**
     * Half of what arrives on a facilities network is declined, and a job on the
     * board nobody is doing is a dispatcher's problem and a margin report's.
     */
    const mirrored = await order();
    const jobId = await job();
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "rejected", jobId }))
      .rejects.toThrow(/declined work order does not get a job/);
  });

  it("will not let us declare the client cancelled it", async () => {
    /**
     * A contractor who could mark an order cancelled by the client could make
     * their own missed deadline look like the client's change of mind, and the
     * portal would disagree the moment anybody looked.
     */
    const mirrored = await order();
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "cancelled_by_client" }))
      .rejects.toThrow(/Only the client's system/);
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "reopened" }))
      .rejects.toThrow(/Only the client's system/);
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "closed" }))
      .rejects.toThrow(/Only the client's system/);
  });

  it("will not un-accept on a network where acceptance is final", async () => {
    /**
     * A product that lets a dispatcher un-accept has taught them a habit that
     * costs a chargeback the first time it matters.
     */
    const claim = await order({ sourceSystem: "ahs", externalId: "CLAIM-2" });
    await externalWork.move(owner(), { id: claim.id, to: "accepted" });
    await expect(externalWork.move(owner(), { id: claim.id, to: "rejected" }))
      .rejects.toThrow(/makes acceptance final/);
  });

  it("does un-accept where the network allows it", async () => {
    /**
     * The other side of the same flag, so the refusal above is about the flag
     * rather than about the transition.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    const declined = await externalWork.move(owner(), { id: mirrored.id, to: "rejected" });
    expect(declined.state).toBe("rejected");
  });

  it("refuses Accept on a network that has no accept call, and says what to do", async () => {
    /**
     * An Accept that posts nowhere is worse than no Accept, because it tells a
     * dispatcher the job is theirs when the client has not heard from us.
     */
    const warranty = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-2" });
    await expect(externalWork.move(owner(), { id: warranty.id, to: "accepted" }))
      .rejects.toThrow(/Submit the invoice instead/);
  });

  it("takes an order on such a network by invoicing it", async () => {
    const warranty = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-3" });
    const invoiceId = await invoice();
    const taken = await externalWork.acceptViaInvoice(owner(), {
      id: warranty.id, invoiceId,
    });
    expect(taken.state).toBe("invoiced");
    expect(taken.pendingPush).toBe(true);
    expect(taken.payload["invoicedWith"]).toBe(invoiceId);
  });

  it("refuses accept-via-invoice with an invoice belonging to nobody", async () => {
    /**
     * The sweep found nothing covering this. An invoice id that resolves to
     * nothing would be written into the payload as the thing we invoiced with,
     * and the record would say a claim was submitted against an invoice that
     * does not exist, which is the one record a warranty administrator asks for
     * when a payment is queried.
     */
    const warranty = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-5" });
    await expect(externalWork.acceptViaInvoice(owner(), {
      id: warranty.id, invoiceId: fixtureId("exw:ghost-invoice"),
    })).rejects.toThrow(NotFoundError);
  });

  it("refuses accept-via-invoice with another company's invoice", async () => {
    /**
     * Row level security rather than a clause: the lookup carries the clause too,
     * so this would pass through either. The point of the test is that the answer
     * is the same as for an invoice that does not exist.
     */
    const warranty = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-6" });
    const [theirs] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days)
      values (${OTHER_ORG}, 'commercial', 'Theirs', 30) returning id`;
    const [theirInvoice] = await raw<{ id: string }[]>`
      insert into public.invoice (
        organization_id, number, customer_id, status, issued_on, currency,
        subtotal, discount_total, tax_total, total, amount_paid, balance, deposit_held
      ) values (
        ${OTHER_ORG}, 777001, ${theirs!.id}, 'open', current_date, 'USD',
        '100.0000', '0', '0', '100.0000', '0', '100.0000', '0'
      ) returning id`;

    await expect(externalWork.acceptViaInvoice(owner(), {
      id: warranty.id, invoiceId: theirInvoice!.id,
    })).rejects.toThrow(NotFoundError);
  });

  it("refuses accept-via-invoice on a network that has an accept call", async () => {
    /**
     * Invoicing for work the client was never told we accepted is how a payment
     * gets held.
     */
    const mirrored = await order();
    const invoiceId = await invoice();
    await expect(externalWork.acceptViaInvoice(owner(), { id: mirrored.id, invoiceId }))
      .rejects.toThrow(/has an accept call/);
  });

  it("will not skip from offered straight to completed", async () => {
    const mirrored = await order();
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "completed" }))
      .rejects.toThrow(/cannot become completed from our side/);
  });

  it("says what we may do next, so a screen does not have to guess", async () => {
    /**
     * An Accept button drawn on a network that has no accept call is the mistake
     * this field exists to prevent.
     */
    const mirrored = await order();
    expect(mirrored.weMayMoveTo.sort()).toEqual(["accepted", "rejected"]);

    const warranty = await order({ sourceSystem: "carrier-dealer", externalId: "WARR-4" });
    expect(warranty.weMayMoveTo).toEqual(["rejected"]);
  });

  it("refuses a state that is not one", async () => {
    const mirrored = await order();
    await expect(externalWork.move(owner(), { id: mirrored.id, to: "on_hold" }))
      .rejects.toThrow(/is not a state a work order can be in/);
  });
});

/* ======================================================= their decisions */

run("when the client's system speaks", () => {
  it("takes their state over ours and loses nothing when we were up to date", async () => {
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.pushed(owner(), { id: mirrored.id });

    const result = await externalWork.applyRemote(owner(), {
      id: mirrored.id, state: "in_progress", externalStatus: "Technician assigned",
    });
    expect(result.conflict).toBeNull();
    expect(result.order.state).toBe("in_progress");
    expect(result.order.externalStatus).toBe("Technician assigned");
  });

  it("writes down what we lost when they overtake an unpushed change", async () => {
    /**
     * THE INVARIANT THE TABLE WAS WRITTEN FOR. "We marked it complete on the 4th
     * and their portal says it was still open on the 11th" is a dispute somebody
     * has to be able to reconstruct, and it is the dispute that decides who pays
     * for the trip. Theirs wins; ours is recorded rather than overwritten.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.move(owner(), { id: mirrored.id, to: "in_progress" });
    await externalWork.move(owner(), { id: mirrored.id, to: "completed" });
    /** Not pushed: we are still holding it. */

    const result = await externalWork.applyRemote(owner(), {
      id: mirrored.id, state: "cancelled_by_client", externalStatus: "Cancelled by store",
    });

    expect(result.order.state).toBe("cancelled_by_client");
    expect(result.conflict).not.toBeNull();
    expect(result.conflict!.lost).toBe("completed");
    expect(result.conflict!.note).toMatch(/We had this as completed and had not told them yet/);
    expect(result.conflict!.note).toMatch(/Cancelled by store/);

    const [line] = await raw<{ action: string; after: Record<string, unknown> }[]>`
      select action, "after" from public.audit_log
      where organization_id = ${ORG} and action = 'external_work_order.conflict'
      order by created_at desc limit 1`;
    expect(line!.after["lost"]).toBe("completed");
    expect(String(line!.after["conflict"])).toMatch(/wins/);
  });

  it("loses nothing when they confirm what we pushed", async () => {
    /**
     * The test is not whether the states differ. A portal confirming the
     * `completed` we pushed differs from nothing and loses nothing, and reporting
     * a conflict there would make every normal sync look like a dispute.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.move(owner(), { id: mirrored.id, to: "in_progress" });
    await externalWork.move(owner(), { id: mirrored.id, to: "completed" });

    const result = await externalWork.applyRemote(owner(), {
      id: mirrored.id, state: "completed", externalStatus: "Work complete",
    });
    expect(result.conflict).toBeNull();
    expect(result.order.pendingPush).toBe(false);
  });

  it("records a status it cannot place rather than refusing the update", async () => {
    /**
     * THE ONE FAILURE THIS TABLE EXISTS TO PREVENT. Their portal has states we
     * have never seen, renames them between releases and skips ours. An
     * integration that stopped on the day the client renamed "Dispatched" to
     * "Assigned" is a vendor whose statuses silently stop arriving.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });

    const result = await externalWork.applyRemote(owner(), {
      id: mirrored.id, state: "Pending Vendor Confirmation",
      externalStatus: "Pending Vendor Confirmation",
    });
    expect(result.conflict).toBeNull();
    /** Our state is left where it was, and their word is kept. */
    expect(result.order.state).toBe("accepted");
    expect(result.order.externalStatus).toBe("Pending Vendor Confirmation");

    const [line] = await raw<{ action: string }[]>`
      select action from public.audit_log
      where organization_id = ${ORG} and action = 'external_work_order.unmapped_status' limit 1`;
    expect(line!.action).toBe("external_work_order.unmapped_status");
  });

  it("lets them reopen a completed order, which we could not do ourselves", async () => {
    /**
     * The commonest dispute on a facilities network, and the asymmetry in one
     * test: we cannot declare a reopen and they can.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.move(owner(), { id: mirrored.id, to: "in_progress" });
    await externalWork.move(owner(), { id: mirrored.id, to: "completed" });
    await externalWork.pushed(owner(), { id: mirrored.id });

    const result = await externalWork.applyRemote(owner(), {
      id: mirrored.id, state: "reopened", externalStatus: "Reopened: callback",
    });
    expect(result.order.state).toBe("reopened");
    expect(result.order.weMayMoveTo.sort()).toEqual(["completed", "in_progress"]);
  });
});

/* ============================================================== the queue */

run("the push queue", () => {
  it("lists what the clients have not been told, oldest first", async () => {
    /**
     * The reader the (organization, pending_push) index was built for and which
     * nothing used. A status changed and never pushed is a contractor whose
     * scorecard says they never responded.
     */
    const first = await order({ externalId: "WO-Q1" });
    const second = await order({ externalId: "WO-Q2" });
    await order({ externalId: "WO-Q3" });

    await externalWork.move(owner(), { id: first.id, to: "accepted" });
    await externalWork.move(owner(), { id: second.id, to: "rejected" });

    const queue = await externalWork.pending(owner(), { limit: 50 });
    expect(queue.data.map((row) => row.externalId)).toEqual(["WO-Q1", "WO-Q2"]);
  });

  it("leaves the order in the queue when a push fails", async () => {
    /**
     * A network that was down has to be told when it comes back. An error that
     * quietly removed the order from the queue would turn a retryable outage into
     * a status the client never hears.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    const failed = await externalWork.pushFailed(owner(), {
      id: mirrored.id, error: "503 from their gateway",
    });
    expect(failed.pendingPush).toBe(true);
    expect(failed.lastPushError).toBe("503 from their gateway");

    const queue = await externalWork.pending(owner(), { limit: 50 });
    expect(queue.data.map((row) => row.id)).toContain(mirrored.id);
  });

  it("refuses a failure with no reason recorded", async () => {
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await expect(externalWork.pushFailed(owner(), { id: mirrored.id, error: "   " }))
      .rejects.toThrow(/Record what went wrong/);
  });

  it("clears a stale error when we move the order again", async () => {
    /**
     * A failure recorded against the status we pushed last week says nothing
     * about the one we are pushing now, and leaving it would make a stale error
     * look like a current one.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    await externalWork.pushFailed(owner(), { id: mirrored.id, error: "503" });
    const moved = await externalWork.move(owner(), { id: mirrored.id, to: "in_progress" });
    expect(moved.lastPushError).toBeNull();
  });

  it("stops owing a push once the client's system has spoken", async () => {
    /**
     * Cleared whether they agreed or overtook us, and both are honest: if they
     * agreed, the conversation is up to date; if they overtook us, the thing we
     * were going to say is no longer true and pushing it would be arguing with
     * the system of record.
     */
    const mirrored = await order();
    await externalWork.move(owner(), { id: mirrored.id, to: "accepted" });
    expect((await externalWork.get(owner(), { id: mirrored.id })).pendingPush).toBe(true);

    await externalWork.applyRemote(owner(), { id: mirrored.id, state: "cancelled_by_client" });
    expect((await externalWork.get(owner(), { id: mirrored.id })).pendingPush).toBe(false);
  });

  it("owes nothing for an order that only arrived", async () => {
    /** They already know: they sent it. */
    const mirrored = await order();
    expect(mirrored.pendingPush).toBe(false);
    const queue = await externalWork.pending(owner(), { limit: 50 });
    expect(queue.data).toEqual([]);
  });
});

/* ============================================================= the reads */

run("reading the queue", () => {
  it("filters by state, network and whether a push is owed", async () => {
    const a = await order({ externalId: "WO-F1", sourceSystem: "corrigo" });
    await order({ externalId: "WO-F2", sourceSystem: "servicechannel" });
    await externalWork.move(owner(), { id: a.id, to: "accepted" });

    expect((await externalWork.list(owner(), { state: "accepted", limit: 50 })).data)
      .toHaveLength(1);
    expect((await externalWork.list(owner(), { sourceSystem: "SERVICECHANNEL", limit: 50 })).data)
      .toHaveLength(1);
    expect((await externalWork.list(owner(), { pendingPush: true, limit: 50 })).data)
      .toHaveLength(1);
    expect((await externalWork.list(owner(), { pendingPush: false, limit: 50 })).data)
      .toHaveLength(1);
  });

  it("refuses a state filter that is not a state", async () => {
    await expect(externalWork.list(owner(), { state: "on_hold", limit: 50 }))
      .rejects.toThrow(/is not a state/);
  });

  it("says what to know about each network before a dispatcher clicks", async () => {
    /**
     * A read with no rows behind it, which is the point: a contractor needs to
     * know a warranty administrator's acceptance is final BEFORE they click it.
     */
    await order({ sourceSystem: "ahs", externalId: "CLAIM-9" });
    const sources = await externalWork.sources(owner(), {});
    const byKey = new Map(sources.data.map((row) => [row.key, row]));
    expect(byKey.get("ahs")!.acceptanceIsIrreversible).toBe(true);
    expect(byKey.get("ahs")!.orders).toBe(1);
    expect(byKey.get("ahs")!.note).toMatch(/final/);
    expect(byKey.get("corrigo")!.orders).toBe(0);
  });

  it("names a network it has no profile for rather than hiding it", async () => {
    /**
     * The list is documentation rather than a gate. A company working a network
     * nobody wrote a profile for should see it on this screen, with the cautious
     * defaults it was given, rather than find it missing.
     */
    await order({ sourceSystem: "regional-warranty-co", externalId: "X-9" });
    const sources = await externalWork.sources(owner(), {});
    expect(sources.unprofiled).toEqual([{ key: "regional-warranty-co", orders: 1 }]);
    expect(sources.cautiousDefaults.acceptanceIsIrreversible).toBe(true);
  });
});

/* =========================================================== who may do it */

run("who may work the queue", () => {
  it("tells reading the queue apart from acting on it", async () => {
    const mirrored = await externalWork.receive(granted("contract:write"), {
      sourceSystem: "corrigo", externalId: "WO-P1",
    });
    await expect(externalWork.receive(granted("contract:read"), {
      sourceSystem: "corrigo", externalId: "WO-P2",
    })).rejects.toThrow(/permission/);
    await expect(externalWork.list(granted("contract:write"), { limit: 10 }))
      .rejects.toThrow(/permission/);
    expect((await externalWork.list(granted("contract:read"), { limit: 10 })).data)
      .toHaveLength(1);
    expect(mirrored.externalId).toBe("WO-P1");
  });

  it("will not let one company see or move another's orders", async () => {
    const mine = await order();
    await expect(externalWork.get(other(), { id: mine.id })).rejects.toThrow(NotFoundError);
    await expect(externalWork.move(other(), { id: mine.id, to: "accepted" }))
      .rejects.toThrow(NotFoundError);
    await expect(externalWork.applyRemote(other(), { id: mine.id, state: "closed" }))
      .rejects.toThrow(NotFoundError);
    expect((await externalWork.list(other(), { limit: 50 })).data).toEqual([]);
  });

  it("lets two companies hold the same network's order id", async () => {
    /**
     * The unique index is on (organization, source system, external id). A
     * facilities network sends the same order to several vendors, and two of them
     * on one deployment must both be able to mirror it.
     */
    await externalWork.receive(owner(), { sourceSystem: "corrigo", externalId: "WO-SHARED" });
    const theirs = await externalWork.receive(other(), {
      sourceSystem: "corrigo", externalId: "WO-SHARED",
    });
    expect(theirs.externalId).toBe("WO-SHARED");
  });

  it("refuses a job belonging to nobody", async () => {
    const mirrored = await order();
    await expect(externalWork.move(owner(), {
      id: mirrored.id, to: "accepted", jobId: fixtureId("exw:ghost"),
    })).rejects.toThrow(NotFoundError);
  });
});

/* =========================================================== the arithmetic */

describe("the state machine, on its own", () => {
  it("lets nobody but the client cancel, reopen or close", () => {
    for (const to of ["cancelled_by_client", "reopened", "closed"] as const) {
      for (const from of ew.STATES) {
        const verdict = ew.checkMove(from, to, {
          acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false,
        });
        expect(verdict.ok, `${from} -> ${to} should be theirs to say`).toBe(false);
        if (!verdict.ok) expect(verdict.refusal.reason).toBe("theirs_to_say");
      }
    }
  });

  it("accepts anything from them, including a state we have never seen", () => {
    /**
     * A validated list would refuse an inbound update because we had not heard of
     * its status, and refusing to record what the system of record says is the one
     * failure this table exists to prevent.
     */
    for (const from of ew.STATES) {
      for (const to of ew.STATES) {
        expect(ew.theyMayMoveTo(from, to)).toBe(true);
      }
    }
  });

  it("owes a push for everything except an order that only arrived", () => {
    expect(ew.owesPush("offered")).toBe(false);
    for (const state of ew.STATES.filter((s) => s !== "offered")) {
      expect(ew.owesPush(state), `${state} should owe a push`).toBe(true);
    }
  });

  it("loses nothing when there was nothing in flight", () => {
    expect(ew.reconcile({ ours: "accepted", theirs: "in_progress", pendingPush: false }))
      .toEqual({ outcome: "accepted_theirs", state: "in_progress", lost: null });
  });

  it("loses ours when we were still holding a different change", () => {
    expect(ew.reconcile({ ours: "completed", theirs: "cancelled_by_client", pendingPush: true }))
      .toEqual({ outcome: "ours_lost", state: "cancelled_by_client", lost: "completed" });
  });

  it("loses nothing when they agree with what we were holding", () => {
    expect(ew.reconcile({ ours: "completed", theirs: "completed", pendingPush: true }).lost)
      .toBeNull();
  });

  it("has a sentence for every refusal, written for the person reading it", () => {
    const flags = { acceptanceIsIrreversible: true, acceptsViaInvoiceOnly: true };
    for (const from of ew.STATES) {
      for (const to of ew.STATES) {
        const verdict = ew.checkMove(from, to, flags);
        if (verdict.ok) continue;
        expect(verdict.refusal.message.length).toBeGreaterThan(30);
      }
    }
  });

  it("gives every named network a note and defaults", () => {
    expect(ew.SOURCES.length).toBeGreaterThan(3);
    for (const source of ew.SOURCES) {
      expect(source.note.length).toBeGreaterThan(40);
      expect(ew.defaultsFor(source.key)).toEqual(source.defaults);
    }
  });

  it("is cautious about a network with no profile", () => {
    expect(ew.defaultsFor("nobody-has-heard-of-this")).toEqual(ew.CAUTIOUS);
    expect(ew.CAUTIOUS.acceptanceIsIrreversible).toBe(true);
  });

  it("writes a conflict note somebody can read months later", () => {
    const note = ew.conflictNote({
      lost: "completed", theirs: "cancelled_by_client", theirStatus: "Cancelled by store",
    });
    expect(note).toMatch(/We had this as completed/);
    expect(note).toMatch(/cancelled by client \("Cancelled by store"\)/);
    expect(note).toMatch(/is not in their record/);
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a refusal about the arrangement, not a missing row", () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
