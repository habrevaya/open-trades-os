import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Orders, Queue, Sources, type OrderRow, type SourceRow,
} from "../src/app/(app)/contracts/external/ExternalWorkView";
import { externalWork as ew } from "@opentradesos/core";
import { NAV } from "../src/lib/nav";

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: "o1", sourceSystem: "corrigo", sourceLabel: "Corrigo",
  externalId: "CORR-99812", externalNumber: "99812",
  state: "offered", externalStatus: "Dispatched",
  externalIsSystemOfRecord: true, acceptanceIsIrreversible: false,
  acceptsViaInvoiceOnly: false, jobId: null, lastSyncedAt: null,
  pendingPush: false, lastPushError: null,
  weMayMoveTo: ["accepted", "rejected"],
  ...over,
});

const source = (over: Partial<SourceRow> = {}): SourceRow => ({
  key: "corrigo", label: "Corrigo", note: "A facilities network. Status pushes are scored.",
  acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false, orders: 3,
  ...over,
});

/** M31's MIRROR ON A SCREEN: TWO STATUSES, NEVER RECONCILED */
describe("work from other systems", () => {
  it("shows their word beside ours rather than instead of it", () => {
    /**
     * Their status is the only thing that survives them renaming one, and "we
     * marked it complete on the 4th and their portal says it was still open on
     * the 11th" is the dispute that decides who pays.
     */
    const html = renderToStaticMarkup(<Orders orders={[order({
      state: "completed", externalStatus: "In Progress",
    })]} />);
    expect(html).toContain("Completed");
    expect(html).toContain("In Progress");
    expect(html).toContain("Theirs is the record");
  });

  it("says nothing yet rather than blank when they have told us no status", () => {
    const html = renderToStaticMarkup(<Orders orders={[order({ externalStatus: null })]} />);
    expect(html).toContain("Nothing yet");
  });

  it("warns that acceptance is final before the button, not after", () => {
    /**
     * On the row rather than in a dialogue. The thing a contractor needs to know
     * before clicking Accept is that on this network it cannot be undone, and
     * after the fact is too late.
     */
    const html = renderToStaticMarkup(<Orders orders={[order({
      acceptanceIsIrreversible: true,
    })]} />);
    expect(html).toContain("Accepting is final here");
  });

  it("offers only the moves the service says are possible", () => {
    /**
     * The screen does not know the transition table. `weMayMoveTo` is computed
     * from the state and the network's flags, so a screen cannot offer a move the
     * module would refuse.
     */
    const html = renderToStaticMarkup(<Orders
      orders={[order({ weMayMoveTo: ["accepted", "rejected"] })]}
      controls={(o) => <>{o.weMayMoveTo.map((to) => <button key={to}>{to}</button>)}</>}
    />);
    expect(html).toContain("accepted");
    expect(html).toContain("rejected");
    expect(html).not.toContain("in_progress");
  });

  it("names the states a contractor may never declare", () => {
    /**
     * Both directions, against core. `cancelled_by_client` and `reopened` are
     * theirs to say: a contractor who could mark an order cancelled by the client
     * could make their own missed deadline look like the client's doing. So no
     * state in `OURS` may be one of those, whatever a screen might render.
     */
    for (const from of ew.STATES) {
      const ours = ew.STATES.filter((to) =>
        ew.checkMove(from, to, { acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false }).ok);
      expect(ours).not.toContain("cancelled_by_client");
      expect(ours).not.toContain("reopened");
    }
  });

  it("says a change has not been pushed, and what the last failure was", () => {
    /**
     * The queue nothing read before the service existed. A status changed and
     * never pushed is a contractor whose scorecard says they never responded, and
     * the scorecard decides the next dispatch.
     */
    const html = renderToStaticMarkup(<Orders orders={[order({
      state: "completed", pendingPush: true, lastPushError: "401 from their gateway",
    })]} />);
    expect(html).toContain("Not yet");
    expect(html).toContain("401 from their gateway");
  });

  it("counts what is owed rather than listing it as a tidiness problem", () => {
    const html = renderToStaticMarkup(<Queue orders={[
      order({ state: "completed", pendingPush: true }),
      order({ id: "o2", externalNumber: "99813", state: "in_progress", pendingPush: true }),
    ]} />);
    expect(html).toContain("2 orders have a change");
    expect(html).toContain("costs the next dispatch");
  });

  it("says nothing is owed rather than showing an empty list", () => {
    const html = renderToStaticMarkup(<Queue orders={[]} />);
    expect(html).toContain("Nothing owed");
  });

  it("puts each network's caveat where the decision is made", () => {
    const html = renderToStaticMarkup(<Sources unprofiled={[]} sources={[
      source(),
      source({ key: "ahs", label: "Home warranty administrator", acceptanceIsIrreversible: true }),
      source({ key: "oem", label: "Manufacturer", acceptsViaInvoiceOnly: true, orders: 0 }),
    ]} />);
    expect(html).toContain("Accepting cannot be undone");
    expect(html).toContain("raising the invoice is the acceptance");
    /** A network this company has not worked is listed with no count rather than hidden. */
    expect(html).toContain("Manufacturer");
    expect(html).toContain("3 orders");
  });

  it("lists a network nobody wrote a profile for, because the list is notes not a gate", () => {
    /**
     * A regional warranty administrator nobody has heard of is as real as
     * Corrigo. Hiding it would make the profile list look like what is allowed.
     */
    const html = renderToStaticMarkup(<Sources
      sources={[source()]}
      unprofiled={[{ key: "regional-warranty-co", orders: 4 }]}
    />);
    expect(html).toContain("regional-warranty-co (4)");
    expect(html).toContain("notes rather than a list of what is allowed");
  });

  it("is a child of Contracts", () => {
    const contracts = NAV.flatMap((g) => g.items).find((i) => i.href === "/contracts");
    expect(contracts?.children?.map((c) => c.href)).toContain("/contracts/external");
    expect(contracts?.permission).toBe("contract:read");
  });
});
