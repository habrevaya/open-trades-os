import { describe, it, expect } from "vitest";
import { partiesFromForm, fieldNames } from "@/lib/job-parties";
import { parties } from "@opentradesos/core";

/**
 * The form posts twenty-two fields and the service takes a list. This is the
 * translation, and every bug in it is silent: a role that vanishes on save, a
 * customer id landing in a text name, a reference attached to the wrong one.
 * None of them throw and none of them are visible until somebody reads the
 * job back a week later.
 */
const form = (values: Record<string, string>) =>
  (field: string) => values[field] ?? null;

describe("the party form", () => {
  it("leaves out a role nobody holds", () => {
    expect(partiesFromForm(form({}), "cust-1")).toEqual([]);
  });

  it("attaches the customer record rather than their typed name", () => {
    const rows = partiesFromForm(form({
      who_bill_to: "customer",
      // Left over in the box from before they switched the select. It must
      // not be saved: a party is a record or a name, and both is neither.
      name_bill_to: "somebody else entirely",
    }), "cust-1");

    expect(rows).toEqual([{ role: "bill_to", customerId: "cust-1" }]);
  });

  it("keeps a name for a party we have no record of", () => {
    const rows = partiesFromForm(form({
      who_site_contact: "external",
      name_site_contact: "  Lindmark Design, Suite 400  ",
      ref_site_contact: " Priya Raman ",
    }), "cust-1");

    expect(rows).toEqual([{
      role: "site_contact",
      externalName: "Lindmark Design, Suite 400",
      externalReference: "Priya Raman",
    }]);
  });

  it("passes an empty name through, so the service can name the role", () => {
    // Dropping the row here would show them a saved form with the role back
    // on Nobody and no explanation of why their choice did not take.
    const rows = partiesFromForm(form({ who_approver: "external", name_approver: "  " }), "c");
    expect(rows).toEqual([{ role: "approver", externalName: "" }]);
  });

  it("omits a blank reference rather than storing an empty string", () => {
    const rows = partiesFromForm(form({
      who_payer: "external", name_payer: "Acme Warranty", ref_payer: "   ",
    }), "c");
    expect(rows[0]).not.toHaveProperty("externalReference");
  });

  it("ignores a who it does not recognise", () => {
    // A hand-posted form, or an option added to the select and nowhere else.
    expect(partiesFromForm(form({ who_owner: "adjuster", name_owner: "X" }), "c")).toEqual([]);
  });

  it("carries every role, each with its own name and nobody else's", () => {
    // Twenty-two fields with a shared prefix per row is exactly the shape
    // that reads the approver's name onto the payer and looks fine doing it.
    const every = Object.fromEntries(
      parties.PARTY_ROLE_KEYS.flatMap((role) => [
        [fieldNames(role).who, "external"],
        [fieldNames(role).name, `name of the ${role}`],
        [fieldNames(role).reference, `ref of the ${role}`],
      ]),
    );

    expect(partiesFromForm(form(every), "c")).toEqual(
      parties.PARTY_ROLE_KEYS.map((role) => ({
        role,
        externalName: `name of the ${role}`,
        externalReference: `ref of the ${role}`,
      })),
    );
  });

  it("reads the field names the form actually writes", () => {
    // The form and this parser share `fieldNames`. If they ever stop sharing
    // it, the form posts twenty-two fields nothing reads and every save
    // clears the whole cast without saying so.
    expect(fieldNames("bill_to"))
      .toEqual({ who: "who_bill_to", name: "name_bill_to", reference: "ref_bill_to" });
  });
});
