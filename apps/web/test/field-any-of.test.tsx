import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fieldFrom } from "../src/lib/field-filter";
import { CustomFieldFilter } from "../src/components/CustomFieldFilter";
import { definitionFrom, queryFor } from "../src/lib/report-params";
import { describeDefinition } from "../src/lib/report-words";

/**
 * "ANY OF THESE" ACROSS FIELDS, ON THE ADDRESS AND IN WORDS
 *
 * AND is what narrowing a list means, so it is what a list is unless the
 * address says otherwise, and "any" is only ever said back in the words
 * that make it unmistakable: "or whose", "Any of:".
 */
const declared = [
  { key: "plan", label: "Plan", dataType: "select", options: ["Annual", "Monthly"], required: false },
  { key: "pets", label: "Pets", dataType: "boolean", options: [], required: false },
];
const two = { field: ["plan", "pets"], value: ["Annual", "yes"] };

describe("the customer list's address", () => {
  it("is all of the fields unless it says any, and says any only from the second field", () => {
    expect(fieldFrom(two).match).toBe("all");
    expect(fieldFrom({ ...two, fieldmatch: "any" })).toMatchObject({
      match: "any",
      byField: { fields: ["plan:Annual", "pets:yes"], fieldMatch: "any" },
      keep: { fieldmatch: "any" },
    });
    expect(fieldFrom({ ...two, fieldmatch: "either" }).match).toBe("all");
    // One field is the same either way, so a stray word on the address does nothing.
    expect(fieldFrom({ field: "plan", value: "Annual", fieldmatch: "any" })).toMatchObject({ match: "all", byField: { fields: ["plan:Annual"] } });
    expect(fieldFrom({ field: "plan", value: "Annual", fieldmatch: "any" }).byField).not.toHaveProperty("fieldMatch");
  });
});

describe("the filter under the customer list", () => {
  const draw = (match: "all" | "any", anyOf: boolean) => renderToStaticMarkup(
    <CustomFieldFilter
      action="/customers" declared={declared} pairs={[{ key: "plan", value: "Annual" }, { key: "pets", value: "yes" }]}
      noun="customers" match={match} anyOf={anyOf}
    />,
  );

  it("says and, and offers any of these, where the list can", () => {
    const html = draw("all", true);
    expect(html).toContain("whose Plan is Annual, and whose Pets is yes.");
    expect(html).toContain("Show customers that match any of these");
    expect(html).toContain("fieldmatch=any");
  });

  it("says or once it is any, keeps it on the next field added, and offers the way back", () => {
    const html = draw("any", true);
    expect(html).toContain("whose Plan is Annual, or whose Pets is yes.");
    expect(html).toContain("Show only customers that match all of these");
    expect(html).toContain('name="fieldmatch" value="any"');
    expect(html).toContain("Or field");
  });

  it("offers nothing of the kind on a list that cannot do it", () => {
    const html = draw("all", false);
    expect(html).not.toContain("any of these");
    expect(html).not.toContain("fieldmatch");
  });
});

describe("the report builder's address and words", () => {
  it("carries any in the definition and back out, and leaves all unwritten", () => {
    const params = { dataset: "jobs", measures: "count", filter: ["customer_cf_plan:eq:Annual", "customer_cf_pets:eq:true"] };
    expect(definitionFrom(params)).not.toHaveProperty("fieldMatch");
    const any = definitionFrom({ ...params, fieldmatch: "any" })!;
    expect(any.fieldMatch).toBe("any");
    expect(queryFor(any)).toContain("fieldmatch=any");
    expect(queryFor(definitionFrom(params)!)).not.toContain("fieldmatch");
  });

  it("says the fields as one line, and leaves the others their own", () => {
    const dataset = {
      key: "jobs", label: "Jobs",
      dimensions: [
        { key: "customer_cf_plan", label: "Customer: Plan", type: "text", sql: "x", field: true },
        { key: "customer_cf_pets", label: "Customer: Pets", type: "text", sql: "y", field: true },
        { key: "status", label: "Status", type: "status", sql: "z" },
      ],
    } as never;
    const filters = [
      { dimension: "customer_cf_plan", op: "eq" as const, value: "Annual" },
      { dimension: "status", op: "neq" as const, value: "cancelled" },
      { dimension: "customer_cf_pets", op: "eq" as const, value: "true" },
    ];
    expect(describeDefinition({ dataset: "jobs", dimensions: [], measures: ["count"], filters, fieldMatch: "any" }, dataset, "America/Chicago"))
      .toEqual(["Any of: Customer: Plan is Annual; Customer: Pets is true", "Status is not Cancelled"]);
    expect(describeDefinition({ dataset: "jobs", dimensions: [], measures: ["count"], filters }, dataset, "America/Chicago"))
      .toEqual(["Customer: Plan is Annual", "Status is not Cancelled", "Customer: Pets is true"]);
  });
});
