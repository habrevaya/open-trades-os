import { describe, it, expect } from "vitest";
import { reporting, membership } from "../src/index";

/**
 * WHO STAYED ON A PLAN
 *
 * Retention, renewal and churn, each excluding the customer who moved or sold
 * the home, and each saying how many of its losses have no recorded reason
 * rather than guessing at them. The SQL in the scorecard is held to these by
 * the integration test; these say what each figure means.
 */
type A = reporting.AgreementFacts;

const agreement = (id: string, over: Partial<A> = {}): A => ({
  id, customerId: `c-${id}`, propertyId: `p-${id}`, status: "active", startedOn: "2026-01-01",
  endsOn: "2027-01-01", cancelledOn: null, cancellationCode: null, renewalCount: 0, ...over,
});

const FROM = "2026-09-01";
const TO = "2026-09-30";

describe("when an agreement is running", () => {
  it("runs from its first day until the day it is cancelled, or the end of a term it lapsed at", () => {
    expect(reporting.runningOn(agreement("a"), "2026-01-01")).toBe(true);
    expect(reporting.runningOn(agreement("a"), "2025-12-31")).toBe(false);
    expect(reporting.runningOn(agreement("a", { status: "pending" }), FROM)).toBe(false);
    const cancelled = agreement("a", { status: "cancelled", cancelledOn: "2026-09-10" });
    expect(reporting.runningOn(cancelled, "2026-09-09")).toBe(true);
    expect(reporting.runningOn(cancelled, "2026-09-10")).toBe(false);
    const lapsed = agreement("a", { status: "lapsed", endsOn: "2026-09-15" });
    expect(reporting.runningOn(lapsed, "2026-09-14")).toBe(true);
    expect(reporting.runningOn(lapsed, "2026-09-15")).toBe(false);
    /** Active past its end is waiting on the worker's renewal, and still runs. */
    expect(reporting.runningOn(agreement("a", { endsOn: "2026-09-15" }), TO)).toBe(true);
  });
});

describe("what says the home was left", () => {
  it("is a cancellation coded moved or sold, or the link to the address ended in time", () => {
    expect(reporting.leftTheHome(agreement("a", { cancellationCode: "sold" }), [], TO)).toBe(true);
    expect(reporting.leftTheHome(agreement("a", { cancellationCode: "price" }), [], TO)).toBe(false);
    const link = (endedOn: string | null) => [{ customerId: "c-a", propertyId: "p-a", endedOn }];
    expect(reporting.leftTheHome(agreement("a"), link("2026-09-20"), TO)).toBe(true);
    /** Ended after the window, or before the plan began, says nothing about this loss. */
    expect(reporting.leftTheHome(agreement("a"), link("2026-10-02"), TO)).toBe(false);
    expect(reporting.leftTheHome(agreement("a"), link("2025-06-01"), TO)).toBe(false);
    expect(reporting.leftTheHome(agreement("a", { propertyId: null }), link("2026-09-20"), TO)).toBe(false);
  });
});

describe("recurring customer retention", () => {
  it("keeps an account on any plan, leaves a move or a sale out of both halves, and names the unknown", () => {
    const agreements: A[] = [
      agreement("kept"),
      agreement("price", { status: "cancelled", cancelledOn: "2026-09-12", cancellationCode: "price" }),
      agreement("moved", { status: "cancelled", cancelledOn: "2026-09-12", cancellationCode: "moved" }),
      agreement("legacy", { status: "cancelled", cancelledOn: "2026-09-12", cancellationCode: null }),
      /** Lapsed, and the house was sold: no cancellation said so, the address did. */
      agreement("sold", { status: "lapsed", endsOn: "2026-09-20" }),
      /** Started inside the window: not an account at the start. */
      agreement("new", { startedOn: "2026-09-05" }),
      /** Two plans, one cancelled: still an account. */
      agreement("two1", { customerId: "c-two", status: "cancelled", cancelledOn: "2026-09-03", cancellationCode: "service" }),
      agreement("two2", { customerId: "c-two" }),
    ];
    const links = [{ customerId: "c-sold", propertyId: "p-sold", endedOn: "2026-09-25" }];
    expect(reporting.retention({ agreements, links, from: FROM, to: TO })).toEqual({
      numerator: ["c-kept", "c-two"],
      denominator: ["c-kept", "c-legacy", "c-price", "c-two"],
      excluded: ["c-moved", "c-sold"],
      unknown: ["c-legacy"],
    });
  });
});

describe("programme renewal", () => {
  it("counts terms that reached their end by today, renewed or not, and leaves out a sale", () => {
    const agreements: A[] = [
      agreement("renewed", { renewalCount: 1, endsOn: "2027-09-10" }),
      agreement("lapsed", { status: "lapsed", endsOn: "2026-09-10" }),
      agreement("sold", { status: "lapsed", endsOn: "2026-09-10" }),
      agreement("cancelledAfter", { status: "cancelled", endsOn: "2026-09-10", cancelledOn: "2026-09-11", cancellationCode: null }),
      /** Cancelled half way: never reached a renewal decision. */
      agreement("midTerm", { status: "cancelled", endsOn: "2026-09-10", cancelledOn: "2026-05-01", cancellationCode: "price" }),
      /** Ends later this month than today: not reached yet. */
      agreement("later", { endsOn: "2026-09-28" }),
    ];
    const terms = [
      { agreementId: "renewed", term: 1, endsOn: "2026-09-10" },
      { agreementId: "renewed", term: 2, endsOn: "2027-09-10" },
    ];
    const links = [{ customerId: "c-sold", propertyId: "p-sold", endedOn: "2026-09-01" }];
    expect(reporting.renewals({ agreements, terms, links, from: FROM, to: TO, today: "2026-09-20" })).toEqual({
      numerator: ["renewed:1"],
      denominator: ["cancelledAfter:1", "lapsed:1", "renewed:1"],
      excluded: ["sold:1"],
      unknown: ["cancelledAfter:1"],
    });
  });
});

describe("subscription churn", () => {
  it("counts losses other than a move or a sale over everything on at the start", () => {
    const agreements: A[] = [
      agreement("kept"),
      agreement("service", { status: "cancelled", cancelledOn: "2026-09-12", cancellationCode: "service" }),
      agreement("sold", { status: "cancelled", cancelledOn: "2026-09-12", cancellationCode: "sold" }),
      agreement("legacy", { status: "cancelled", cancelledOn: "2026-09-12" }),
      agreement("lapsed", { status: "lapsed", endsOn: "2026-09-12" }),
      agreement("gone", { status: "cancelled", cancelledOn: "2026-08-12", cancellationCode: "price" }),
    ];
    expect(reporting.churn({ agreements, links: [], from: FROM, to: TO })).toEqual({
      numerator: ["lapsed", "legacy", "service"],
      denominator: ["kept", "lapsed", "legacy", "service", "sold"],
      excluded: ["sold"],
      unknown: ["legacy"],
    });
  });
});

describe("a coded cancellation reason", () => {
  it("is one of the list, and something else needs words", () => {
    expect(membership.cancellationProblem("moved", "")).toBeNull();
    expect(membership.cancellationProblem("other", "  ")).toMatch(/in words/);
    expect(membership.cancellationProblem("other", "Going abroad")).toBeNull();
    expect(membership.cancellationProblem("relocating", "")).toMatch(/not one of the reasons/);
    /** No code at all is a caller with only words, as before the list. */
    expect(membership.cancellationProblem(undefined, "Sold the house")).toBeNull();
    expect(membership.cancellationProblem(undefined, "")).toMatch(/needs a reason/);
    expect(membership.leftTheHome("sold")).toBe(true);
    expect(membership.leftTheHome("switched")).toBe(false);
    expect(Object.keys(membership.CANCELLATION_LABEL)).toEqual([...membership.CANCELLATION_CODES]);
  });
});
