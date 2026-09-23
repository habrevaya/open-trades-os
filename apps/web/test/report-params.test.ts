import { describe, it, expect } from "vitest";
import { definitionFrom, definitionFromForm, queryFor } from "../src/lib/report-params";

/**
 * THE BUILDER'S STATE IS THE URL
 *
 * Which makes this the one place a report can be corrupted between being
 * looked at and being saved. Nothing here validates: `resolveReport` in core
 * does that against the catalogue. These check that what went in comes back.
 */

describe("a report definition in a query string", () => {
  it("round trips", () => {
    const definition = {
      dataset: "invoices",
      dimensions: ["month", "customer"],
      measures: ["total", "count"],
      filters: [{ dimension: "status", op: "neq" as const, value: "paid" }],
      from: "2026-01-01",
      to: "2026-10-01",
      orderBy: "total",
    };
    expect(definitionFrom(Object.fromEntries(new URLSearchParams(queryFor(definition)))))
      .toEqual(definition);
  });

  it("round trips a list filter without splitting it into two", () => {
    // `in` is the one whose value is an array, and the packed form uses a
    // comma for both the list and nothing else.
    const definition = {
      dataset: "jobs",
      dimensions: ["status"],
      measures: ["count"],
      filters: [{ dimension: "status", op: "in" as const, value: ["open", "scheduled"] }],
    };
    const back = definitionFrom(Object.fromEntries(new URLSearchParams(queryFor(definition))));
    expect(back?.filters).toEqual(definition.filters);
  });

  it("keeps a value that contains the separator", () => {
    // The dimension and the operator take the first two colons and the value
    // takes the rest, so a customer called "Ace: Plumbing" survives.
    const back = definitionFrom({
      dataset: "jobs", measures: "count", filter: "customer:eq:Ace: Plumbing",
    });
    expect(back?.filters).toEqual([{ dimension: "customer", op: "eq", value: "Ace: Plumbing" }]);
  });

  it("is null when no dataset was named", () => {
    expect(definitionFrom({ measures: "count" })).toBeNull();
  });

  it("packs the add-a-filter row into a filter", () => {
    const back = definitionFrom({
      dataset: "invoices", measures: "total", fd: "status", fo: "neq", fv: "paid",
    });
    expect(back?.filters).toEqual([{ dimension: "status", op: "neq", value: "paid" }]);
  });

  it("adds to the filters already applied rather than replacing them", () => {
    /**
     * The form carries the existing filters as hidden fields and the row adds
     * one. A reader that took only the row would silently drop every filter
     * somebody had already set, and the report would answer a wider question
     * than the screen said it did.
     */
    const back = definitionFrom({
      dataset: "invoices", measures: "total",
      filter: ["status:neq:paid"], fd: "customer", fo: "eq", fv: "Rita",
    });
    expect(back?.filters).toEqual([
      { dimension: "status", op: "neq", value: "paid" },
      { dimension: "customer", op: "eq", value: "Rita" },
    ]);
  });

  it("ignores a half-filled filter row", () => {
    // Choosing a field and typing nothing is somebody changing their mind,
    // not a filter on the empty string.
    expect(definitionFrom({ dataset: "jobs", measures: "count", fd: "status", fo: "eq" })?.filters)
      .toBeUndefined();
  });

  it("drops an operator it does not know", () => {
    // Refusing here would compete with the refusal `resolveReport` already
    // writes. Dropping it produces a definition that runs and reads honestly.
    expect(definitionFrom({ dataset: "jobs", measures: "count", filter: "status:like:%paid%" })?.filters)
      .toBeUndefined();
  });

  it("groups by the same dimension only once", () => {
    // Two of the same in a GROUP BY is a Postgres error rather than a report,
    // and repeated checkboxes are easy to produce with the back button.
    expect(definitionFrom({ dataset: "jobs", measures: "count", dimensions: ["status", "status"] })
      ?.dimensions).toEqual(["status"]);
  });

  it("reads a submitted form the same way it reads a URL", () => {
    const form = new FormData();
    form.append("dataset", "jobs");
    form.append("dimensions", "status");
    form.append("dimensions", "priority");
    form.append("measures", "count");
    expect(definitionFromForm(form)).toEqual({
      dataset: "jobs", dimensions: ["status", "priority"], measures: ["count"],
    });
  });

  it("leaves an empty range off the definition entirely", () => {
    /**
     * An unfilled date input submits an empty string, and `from: ""` reaches
     * the query as `>= ''::date`, which Postgres rejects. The report would
     * fail for anybody who opened the range picker and closed it again.
     */
    const back = definitionFrom({ dataset: "jobs", measures: "count", from: "", to: "" });
    expect(back).not.toHaveProperty("from");
    expect(back).not.toHaveProperty("to");
  });
});
