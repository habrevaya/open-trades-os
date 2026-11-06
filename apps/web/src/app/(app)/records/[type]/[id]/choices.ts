import { billing, customers, customObjects, equipment, jobs, properties, type ServiceContext } from "@opentradesos/api/services";
import { customObjects as rules, PermissionError } from "@opentradesos/core";

/** One thing a record could point at, as the forms that change a link offer it. */
export interface Choice { id: string; title: string; detail: string | null }

export const PLURAL: Record<rules.Link, string> = {
  customer: "customers", property: "addresses", job: "jobs", equipment: "units",
  invoice: "invoices", membership: "the people list", record: "these records",
};

/** What to type to find one, for each link. */
export const HINT: Record<rules.Link, string> = {
  job: "A job number, or words from the job or the customer's name",
  customer: "Part of the customer's name, email or phone",
  property: "Part of the street",
  equipment: "A serial number, or the make or model",
  invoice: "An invoice number or the customer's name",
  membership: "Part of their name",
  record: "Its name or a value",
};

const joined = (parts: Array<string | null | undefined>, by = " ") => parts.filter((p) => p && p.trim() !== "").join(by);

/** People and records are a short list to choose from; everything else is found by words. */
export const listedLink = (to: rules.Link) => to === "membership" || to === "record";

/**
 * WHAT A RECORD COULD POINT AT, FOR ONE LINK
 *
 * Found the way the search box finds things: a job by its number or its words,
 * a customer by name, an address by its street, a unit by its serial or make,
 * an invoice by its number. Each is read through the list the writer is
 * already narrowed on, so a technician is offered the work they were sent to
 * and a branch manager their branch's; the service checks the choice again
 * when it is saved. A person is chosen from the people they may see, and a
 * record from the records of the kind this kind points at. Shared by the page
 * that changes one link and the form that changes several at once.
 */
export async function choicesFor(
  ctx: ServiceContext, kind: { recordKind?: string | null | undefined }, to: rules.Link, q: string | undefined, recordId: string,
): Promise<{ choices: Choice[]; unreadable: boolean }> {
  let choices: Choice[] = [];
  try {
    if (to === "membership") {
      const people = await customObjects.peopleToLink(ctx);
      const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      choices = people.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
        .map((p) => ({ id: p.membershipId, title: p.name, detail: null }));
    } else if (to === "record") {
      const page = await customObjects.listRecords(ctx, { type: kind.recordKind ?? "", limit: 50, ...(q ? { q } : {}) });
      choices = page.data.filter((r) => r.id !== recordId)
        .map((r) => ({ id: r.id, title: r.title, detail: r.job?.name || r.customer?.name || null }));
    } else if (q && q.length >= 2) {
      if (to === "job") {
        choices = (await jobs.list(ctx, { q, limit: 20 })).data
          .map((j) => ({ id: j.id, title: `Job ${j.number}: ${j.summary}`, detail: joined([j.customerName, j.propertyAddress], ", ") || null }));
      } else if (to === "customer") {
        choices = (await customers.list(ctx, { q, limit: 20, includeInactive: false })).data
          .map((c) => ({ id: c.id, title: c.name, detail: c.email ?? c.phone ?? null }));
      } else if (to === "invoice") {
        choices = (await billing.list(ctx, { q, limit: 20 })).data
          .map((i) => ({ id: i.id, title: `Invoice ${i.number}`, detail: i.customerName }));
      } else if (to === "property") {
        choices = (await properties.findByStreet(ctx, { q, limit: 20 })).data
          .map((p) => ({ id: p.id, title: joined([p.line1, p.line2], ", "), detail: joined([p.city, p.state], ", ") || null }));
      } else {
        choices = (await equipment.findUnits(ctx, { q, limit: 20 })).data
          .map((u) => ({
            id: u.id, title: joined([u.tag ?? u.category, joined([u.manufacturer, u.model])], ": "),
            detail: joined([u.serialNumber ? `Serial ${u.serialNumber}` : null, u.street ? `at ${u.street}` : null]) || null,
          }));
      }
    }
  } catch (error) {
    if (!(error instanceof PermissionError)) throw error;
    return { choices: [], unreadable: true };
  }
  return { choices, unreadable: false };
}
