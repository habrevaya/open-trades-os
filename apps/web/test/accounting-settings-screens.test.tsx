import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountMappings, BranchMappings, ProblemsList, problemRecord, problemState, choiceValue,
  type AccountRow, type BranchRow, type Problem,
} from "../src/app/(app)/settings/accounting/Sections";

/**
 * SETTINGS → ACCOUNTING (M14)
 *
 * The account mappings, the branches and the documents the sync could not
 * send, each drawn from what the page read. The books' own lists appear only
 * once somebody asked for them, which is what keeps QuickBooks' metered reads
 * for when a person is choosing.
 */
const action = async () => null;
const books = "QuickBooks Online";

const accounts: AccountRow[] = [
  { code: "1000", name: "Undeposited funds", mapped: { externalId: "35", externalName: "Undeposited Funds", externalKind: "Account" }, needed: false },
  { code: "4000", name: "Revenue from work", mapped: null, needed: true },
  { code: "4150", name: null, mapped: null, needed: false },
];

describe("where each account goes", () => {
  it("lists every account with where it goes, marks the ones needed now, and offers to read the chart", () => {
    const html = renderToStaticMarkup(<AccountMappings books={books} rows={accounts} chart={null} action={action} />);
    expect(html).toContain("Revenue from work");
    expect(html).toContain("Undeposited Funds");
    expect(html).toContain("Needed");
    expect(html).toContain("1 account is needed now.");
    expect(html).toContain("Read the accounts from QuickBooks Online to change these");
    expect(html).toContain('href="/settings/accounting?read=accounts#accounts"');
    // Nothing to choose from until the chart is read.
    expect(html).not.toContain("<select");
  });

  it("offers the chart it read, grouped, with the current choice selected and remembered", () => {
    const html = renderToStaticMarkup(<AccountMappings books={books} rows={accounts} action={action} chart={{
      ok: true,
      items: [
        { externalId: "35", name: "Undeposited Funds", kind: "Account", classification: "asset", number: null, active: true },
        { externalId: "79", name: "Sales", kind: "Account", classification: "income", number: "4000", active: true },
        { externalId: "9", name: "Hours", kind: "Item", classification: "income", number: null, active: true },
        { externalId: "80", name: "Old sales", kind: "Account", classification: "income", number: null, active: false },
      ],
    }} />);
    expect(html).toContain('aria-label="Account 4000 goes to"');
    expect(html).toContain('<optgroup label="Income">');
    expect(html).toContain("4000 Sales");
    expect(html).toContain("Hours (product or service)");
    // An account switched off over there is not offered.
    expect(html).not.toContain("Old sales");
    const current = choiceValue({ id: "35", name: "Undeposited Funds", kind: "Account" });
    expect(html).toContain(`name="was:1000" value="${current.replace(/"/g, "&quot;")}"`);
    expect(html).toContain("Save the mappings");
  });

  it("says why the chart could not be read rather than showing an empty list", () => {
    const html = renderToStaticMarkup(<AccountMappings books={books} rows={accounts} action={action}
      chart={{ ok: false, sentence: "QuickBooks Online has stopped answering reads for now." }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("stopped answering reads");
    expect(html).not.toContain("Save the mappings");
  });
});

const branches: BranchRow[] = [
  { businessUnitId: "b1", name: "Round Rock", active: true, mapped: { externalId: "c1", externalName: "Round Rock", groupId: null, groupName: null } },
  { businessUnitId: "b2", name: "Georgetown", active: true, mapped: null },
  { businessUnitId: "b3", name: "Old shop", active: false, mapped: { externalId: "c9", externalName: "Old", groupId: null, groupName: null } },
];

describe("branches in the books", () => {
  it("shows each branch and what it goes as, with a way to stop sending a mapped one", () => {
    const html = renderToStaticMarkup(<BranchMappings books={books} provider="quickbooks" rows={branches}
      options={null} action={action} unmap={action} />);
    expect(html).toContain("Sent without one");
    expect(html).toContain("Stop sending Round Rock");
    expect(html).not.toContain("Stop sending Georgetown");
    expect(html).toContain("Retired");
    expect(html).toContain("Read the classes from QuickBooks Online to change these");
    expect(html).toContain("Track classes");
  });

  it("offers Xero's tracking options with their category", () => {
    const html = renderToStaticMarkup(<BranchMappings books="Xero" provider="xero" rows={branches} action={action} unmap={action}
      options={{ ok: true, items: [{ externalId: "o1", name: "North", groupId: "g1", groupName: "Region", active: true }] }} />);
    expect(html).toContain("Region: North");
    expect(html).toContain("tracking option");
    // A mapping whose option is gone over there is kept as it was, and said.
    expect(html).toContain("Round Rock (no longer in Xero)");
    expect(html).toContain("Save the branches");
  });

  it("sends a company with no branches to make some", () => {
    const html = renderToStaticMarkup(<BranchMappings books={books} provider="quickbooks" rows={[]}
      options={null} action={action} unmap={action} />);
    expect(html).toContain('href="/settings/branches"');
  });
});

const problem = (over: Partial<Problem>): Problem => ({
  id: "l1", kind: "invoice", entityId: "i1", idempotencyKey: "1042", state: "failed", attempts: 5,
  lastError: "Account 4000 is not mapped.", updatedAt: "2026-10-07T15:00:00.000Z", ...over,
});

describe("documents that did not go", () => {
  it("names each document with a link to it, the reason, and a button to send it again", () => {
    const html = renderToStaticMarkup(<ProblemsList books={books} timezone="America/Chicago" retry={action} stopsAfter={5}
      problems={[problem({}), problem({ id: "l2", kind: "journal", entityId: "j1", idempotencyKey: "OTJ12", state: "deleted", attempts: 0, lastError: null })]} />);
    expect(html).toContain('href="/invoices/i1"');
    expect(html).toContain("Invoice 1042");
    expect(html).toContain("Account 4000 is not mapped.");
    expect(html).toContain("Stopped after 5 tries");
    expect(html).toContain("Deleted in QuickBooks Online");
    expect(html.match(/Send it again/g)).toHaveLength(2);
  });

  it("says nothing is waiting when nothing is", () => {
    const html = renderToStaticMarkup(<ProblemsList books={books} timezone="America/Chicago" retry={action} stopsAfter={5} problems={[]} />);
    expect(html).toContain("Nothing waiting");
  });

  it("does not offer to send again what is already going on the next sync", () => {
    expect(problemState({ state: "failed", attempts: 0, lastError: null }, books, 5)).toMatchObject({ retry: false });
    expect(problemState({ state: "failed", attempts: 2, lastError: "Refused" }, books, 5))
      .toMatchObject({ retry: true, said: "Refused, and tried again on each sync" });
  });

  it("links each kind of document to its own page where it has one", () => {
    expect(problemRecord({ kind: "credit_note", entityId: "n1", idempotencyKey: "CN4" }).href).toBe("/invoices/credit-notes/n1");
    expect(problemRecord({ kind: "customer", entityId: "c1", idempotencyKey: "Jo Ames" })).toEqual({ what: "Customer Jo Ames", href: "/customers/c1" });
    expect(problemRecord({ kind: "payment", entityId: "p1", idempotencyKey: "OT1a2b" }).href).toBeNull();
  });
});
