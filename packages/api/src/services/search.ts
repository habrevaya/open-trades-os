import { can, search as terms, type Permission } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import * as customers from "./customers";
import * as jobs from "./jobs";
import * as billing from "./billing";
import * as estimates from "./estimates";
import * as properties from "./properties";
import * as equipment from "./equipment";
import * as customObjects from "./custom-objects";

/**
 * ONE BOX THAT FINDS THINGS
 *
 * Nothing here reads a table. Each part asks the service that owns its list,
 * with the caller's own context, so the scope a technician is held to on the
 * customer list, the jobs, invoices and estimates they may open and the kinds
 * of record they may read are exactly what this finds. Addresses and units
 * have no narrowed list of their own, so their reads (`properties.findByStreet`,
 * `equipment.findUnits`) apply the customer's scope by the work at the
 * address, the same filter in services/scope.ts. A part the caller holds no
 * permission for is skipped rather than refused: the box is one screen for
 * everybody, and a refusal would say only that customers exist.
 *
 * FIVE OF EACH, AND A WAY TO THE REST. Each group says whether it has more
 * than it shows, and links to its own list filtered by the same words, which
 * the list reads through the same `q` and so agrees with the five. Addresses
 * and units have no list screen, so theirs is this page showing that group
 * alone, at up to fifty.
 *
 * A company's own records are the reason it began: a permit is found by its
 * number or its street from anywhere, rather than by first remembering which
 * job it was on.
 */
export interface SearchHit { id: string; title: string; detail: string | null; href: string }
export interface SearchGroup {
  key: string;
  label: string;
  hits: SearchHit[];
  /** More match than are shown. */
  more: boolean;
  /** The list showing every match, filtered by the same words. Null when this already is it. */
  seeAll: string | null;
}

export const GROUPS = ["customers", "jobs", "invoices", "estimates", "addresses", "units"] as const;
export type GroupKey = (typeof GROUPS)[number];

const EACH = 5;
/** A group shown alone, from its "see all", for the two with no list screen. */
const ALONE = 50;

const joined = (parts: Array<string | null | undefined>, by = " ") => parts.filter((p) => p && p.trim() !== "").join(by);

export async function everything(
  ctx: ServiceContext, input: { q: string; in?: GroupKey | undefined },
): Promise<{ q: string; groups: SearchGroup[] }> {
  const q = input.q.trim();
  if (!terms.isSearchable(q)) return { q, groups: [] };
  const groups: SearchGroup[] = [];
  const limit = input.in ? ALONE : EACH;
  const wanted = (key: GroupKey, permission: Permission) =>
    (input.in === undefined || input.in === key) && can(ctx.actor, permission);
  const listed = (path: string) => (input.in ? null : `${path}?${new URLSearchParams({ q })}`);
  const here = (key: GroupKey) => (input.in ? null : `/search?${new URLSearchParams({ q, in: key })}`);
  const add = (group: SearchGroup) => { if (group.hits.length > 0) groups.push(group); };

  if (wanted("customers", "customer:read")) {
    const page = await customers.list(ctx, { q, limit } as Parameters<typeof customers.list>[1]);
    add({
      key: "customers", label: "Customers", more: page.hasMore, seeAll: listed("/customers"),
      hits: page.data.map((c) => ({ id: c.id, title: c.name, detail: c.email ?? c.phone ?? null, href: `/customers/${c.id}` })),
    });
  }

  if (wanted("jobs", "job:read")) {
    const page = await jobs.list(ctx, { q, limit });
    add({
      key: "jobs", label: "Jobs", more: page.hasMore, seeAll: listed("/jobs"),
      hits: page.data.map((j) => ({
        id: j.id, title: `Job ${j.number}: ${j.summary}`, detail: j.customerName, href: `/jobs/${j.id}`,
      })),
    });
  }

  if (wanted("invoices", "invoice:read")) {
    const page = await billing.list(ctx, { q, limit });
    add({
      key: "invoices", label: "Invoices", more: page.hasMore, seeAll: listed("/invoices"),
      hits: page.data.map((i) => ({ id: i.id, title: `Invoice ${i.number}`, detail: i.customerName, href: `/invoices/${i.id}` })),
    });
  }

  if (wanted("estimates", "estimate:read")) {
    const page = await estimates.list(ctx, { q, limit });
    add({
      key: "estimates", label: "Estimates", more: page.hasMore, seeAll: listed("/estimates"),
      hits: page.data.map((e) => ({
        id: e.id, title: joined([`Estimate ${e.number}`, e.title], ": "), detail: e.customerName, href: `/estimates/${e.id}`,
      })),
    });
  }

  /**
   * An address and a unit say where and what, never whose: the name on an
   * address is a customer the reader may not be able to see, and the box
   * would otherwise be the way to learn who lives at a street they were sent
   * to for somebody else.
   */
  if (wanted("addresses", "property:read")) {
    const page = await properties.findByStreet(ctx, { q, limit });
    add({
      key: "addresses", label: "Addresses", more: page.hasMore, seeAll: here("addresses"),
      hits: page.data.map((p) => ({
        id: p.id, title: joined([p.line1, p.line2], ", "),
        detail: joined([p.city, joined([p.state, p.postalCode])], ", ") || null, href: `/properties/${p.id}`,
      })),
    });
  }

  if (wanted("units", "equipment:read")) {
    const page = await equipment.findUnits(ctx, { q, limit });
    add({
      key: "units", label: "Equipment", more: page.hasMore, seeAll: here("units"),
      hits: page.data.map((u) => ({
        id: u.id,
        title: joined([u.tag ?? u.category, joined([u.manufacturer, u.model])], ": "),
        detail: joined([u.serialNumber ? `Serial ${u.serialNumber}` : null, u.street ? `at ${u.street}` : null]) || null,
        href: `/equipment/${u.id}`,
      })),
    });
  }

  if (input.in === undefined && can(ctx.actor, "record:read")) {
    for (const kind of await customObjects.listKinds(ctx)) {
      const page = await customObjects.listRecords(ctx, { type: kind.key, q, limit: EACH });
      add({
        key: `record:${kind.key}`, label: kind.pluralLabel, more: page.hasMore,
        seeAll: `/records/${kind.key}?${new URLSearchParams({ q })}`,
        hits: page.data.map((r) => ({
          id: r.id, title: r.title,
          detail: r.job?.name || r.customer?.name || r.equipment?.name || null,
          href: `/records/${kind.key}/${r.id}`,
        })),
      });
    }
  }
  return { q, groups };
}

export const handlers = {
  searchEverything: (ctx: ServiceContext, input: { q: string; in?: GroupKey | undefined }) => everything(ctx, input),
} as const;
