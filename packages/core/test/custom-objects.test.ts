import { describe, it, expect } from "vitest";
import { customObjects as co } from "../src/index";

/**
 * A COMPANY'S OWN KIND OF RECORD, CHECKED BEFORE IT IS SAVED
 *
 * The definition of a permit or a truck inspection is a promise every list,
 * form, report and automation built from it keeps. These are the ways a
 * definition could be saved and then break all of them: a key that cannot be
 * written into a field's entity type, a link to something with nowhere to
 * store it, a permission nobody can hold.
 */

describe("a definition", () => {
  it("is saved with what it is called, what it points at and who may see it", () => {
    const decision = co.checkType({
      key: "permit", label: "Permit", pluralLabel: "Permits", titleLabel: "Permit number",
      links: ["job", "property"],
    });
    expect(decision).toEqual({
      ok: true,
      definition: {
        key: "permit", label: "Permit", pluralLabel: "Permits", description: null,
        titleLabel: "Permit number",
        // In the product's order, whatever order they were ticked in.
        links: ["property", "job"],
        readPermission: "record:read", writePermission: "record:write", sortOrder: 0,
        // Pointing at no other kind, and not shown to customers until somebody says so.
        recordKind: null, customerVisible: false,
      },
    });
  });

  it("takes the plural it is given rather than guessing one", () => {
    const decision = co.checkType({ key: "battery", label: "Battery", pluralLabel: "Batteries" });
    expect(decision.ok && decision.definition.pluralLabel).toBe("Batteries");
  });

  it("names each record Name when nothing says otherwise", () => {
    const decision = co.checkType({ key: "truck_inspection", label: "Truck inspection" });
    expect(decision.ok && decision.definition.titleLabel).toBe("Name");
  });

  it("refuses every problem at once, each in words", () => {
    const decision = co.checkType({
      // An invoice became something a record can point at, so the link nothing offers is a vendor.
      key: "Permit Number", label: " ", links: ["vendor", "job", "job"],
      readPermission: "permits:see", writePermission: "record:write",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problems).toEqual([
      expect.stringContaining('"Permit Number" is not a usable key'),
      "Say what one of these is called, like Permit.",
      expect.stringContaining('"vendor" is not something a record can point at'),
      "Job is listed twice.",
      '"permits:see" is not a permission anybody can hold.',
    ]);
  });

  it("can be guarded by any permission in the catalogue, so a custom role works with it", () => {
    const decision = co.checkType({
      key: "truck_inspection", label: "Truck inspection",
      readPermission: "asset:read", writePermission: "asset:checkout",
    });
    expect(decision.ok && [decision.definition.readPermission, decision.definition.writePermission])
      .toEqual(["asset:read", "asset:checkout"]);
  });

  it("writes its fields under an entity type that reads back to its key and nothing else", () => {
    expect(co.entityTypeFor("permit")).toBe("object:permit");
    expect(co.keyOfEntityType("object:permit")).toBe("permit");
    expect(co.keyOfEntityType("customer")).toBeNull();
    expect(co.keyOfEntityType("object:Permit")).toBeNull();
    expect(co.keyOfEntityType("object:permit'; drop table x")).toBeNull();
  });

  it("needs a name on every record", () => {
    expect(co.titleProblem("Permit number", "  ")).toBe("Permit number is required.");
    expect(co.titleProblem("Permit number", "BP-2026-114")).toBeNull();
    expect(co.titleProblem("Permit number", "x".repeat(201))).toContain("longer than two hundred");
  });
});

describe("a spreadsheet, read back", () => {
  it("reads quoted cells, doubled quotes, commas and line breaks inside a cell", () => {
    const rows = co.parseCsv('Permit number,Notes\r\nBP-1,"Gate, then ""side"" door"\r\n"BP-2","two\nlines"\r\n');
    expect(rows).toEqual([
      ["Permit number", "Notes"],
      ["BP-1", 'Gate, then "side" door'],
      ["BP-2", "two\nlines"],
    ]);
  });

  it("takes off the apostrophe this product's own export puts before a formula", () => {
    expect(co.parseCsv("Name\n'=SUM(A1)\n")).toEqual([["Name"], ["=SUM(A1)"]]);
  });

  it("skips blank lines rather than making empty records of them", () => {
    expect(co.parseCsv("Name\n\nA\n,\n")).toEqual([["Name"], ["A"]]);
  });

  it("matches columns by label or key, ignoring case and spacing, and says what it ignored", () => {
    const columns = co.importColumns(
      ["permit number", "Inspected on", "status", "Job number", "Customer ID", "Colour"],
      "Permit number",
      [{ key: "inspected_on", label: "Inspected on" }, { key: "status", label: "Permit status" }],
    );
    expect(columns).not.toBeNull();
    expect(columns!.title).toBe(0);
    expect([...columns!.fields]).toEqual([["inspected_on", 1], ["status", 2]]);
    expect(columns!.links).toEqual({ customer: 4, job_number: 3 });
    expect(columns!.ignored).toEqual(["Colour"]);
  });

  it("refuses a file with no column naming each record", () => {
    expect(co.importColumns(["Inspected on"], "Permit number", [])).toBeNull();
  });

  it("converts a cell to what its field stores without judging it, so the service refuses it in words", () => {
    expect(co.cellValue({ dataType: "number" }, "1,250.5")).toBe(1250.5);
    expect(co.cellValue({ dataType: "number" }, "about ten")).toBe("about ten");
    expect(co.cellValue({ dataType: "boolean" }, "Yes")).toBe(true);
    expect(co.cellValue({ dataType: "boolean" }, "n")).toBe(false);
    expect(co.cellValue({ dataType: "multiselect" }, "gate; dog")).toEqual(["gate", "dog"]);
    expect(co.cellValue({ dataType: "date" }, "soon")).toBe("soon");
    expect(co.cellValue({ dataType: "text" }, "  ")).toBeUndefined();
  });

  it("writes a value back the way it is read", () => {
    for (const [dataType, value] of [
      ["boolean", true], ["multiselect", ["gate", "dog"]], ["number", 12.5], ["date", "2026-03-01"],
    ] as const) {
      const text = co.cellText({ dataType }, value);
      expect(co.cellValue({ dataType }, text)).toEqual(value);
    }
  });
});
