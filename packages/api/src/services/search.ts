import { can, search as terms, type Permission } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import * as customers from "./customers";
import * as jobs from "./jobs";
import * as billing from "./billing";
import * as estimates from "./estimates";
import * as properties from "./properties";
import * as equipment from "./equipment";
import * as customObjects from "./custom-objects";
import * as customerNotes from "./customer-notes";
import * as pricebook from "./pricebook";
import * as people from "./people";

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
 *
 * EXACT FIRST, THEN CLOSE. Each group is read as typed, and when that finds
 * fewer than the group shows, read again with each word allowed to be close
 * to one that is written ("furnice" finds the furnace job), through the same
 * list with the same scope (`text-search.ts`, `core/search`). The close ones
 * come after every exact one, are marked `close`, and only fill the group's
 * own count: the list behind "See all" is the exact matches, so a group's
 * `more` says only whether there are more of those. A query with no word of
 * four letters or more never takes the second look.
 *
 * A customer's notes, the price book and the company's people are groups too,
 * each behind the permission that reads it (`customer:read` through the
 * customer's scope, `pricebook:read`, `user:read` through the people scope).
 */
export interface SearchHit {
  id: string;
  title: string;
  detail: string | null;
  href: string;
  /** Found by a word close to one typed rather than the word itself. Listed after every exact one. */
  close: boolean;
}
export interface SearchGroup {
  key: string;
  label: string;
  hits: SearchHit[];
  /** More exact matches than are shown. */
  more: boolean;
  /** The list showing every exact match, filtered by the same words. Null when this already is it. */
  seeAll: string | null;
}

export const GROUPS = [
  "customers", "jobs", "invoices", "estimates", "addresses", "units", "notes", "pricebook", "people",
] as const;
export type GroupKey = (typeof GROUPS)[number];

const EACH = 5;
/** A group shown alone, from its "see all", for the ones with no list screen. */
const ALONE = 50;

const joined = (parts: Array<string | null | undefined>, by = " ") => parts.filter((p) => p && p.trim() !== "").join(by);

/** A note as one line: the start of it, or the part around the first word typed when that is further in. */
export function excerpt(body: string, q: string, width = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const first = terms.searchTerms(q).words[0];
  const at = first ? flat.toLowerCase().indexOf(first) : -1;
  const start = at > width / 2 ? at - Math.floor(width / 3) : 0;
  const piece = flat.slice(start, start + width).trim();
  return `${start > 0 ? "..." : ""}${piece}${start + width < flat.length ? "..." : ""}`;
}

/**
 * Read a group as typed, then, when that came up short, close: the second
 * read's rows that the first did not find, after the first's, up to the
 * group's count.
 */
async function looked<T extends { id: string }>(
  q: string, limit: number,
  read: (close: boolean, limit: number) => Promise<{ data: T[]; hasMore: boolean }>,
): Promise<{ rows: { row: T; close: boolean }[]; more: boolean }> {
  const exact = await read(false, limit);
  const rows = exact.data.map((row) => ({ row, close: false }));
  if (exact.hasMore || rows.length >= limit || terms.closeWords(terms.searchTerms(q)).length === 0) {
    return { rows, more: exact.hasMore };
  }
  const seen = new Set(rows.map(({ row }) => row.id));
  const near = await read(true, limit + seen.size);
  for (const row of near.data) {
    if (rows.length >= limit) break;
    if (!seen.has(row.id)) rows.push({ row, close: true });
  }
  return { rows, more: false };
}

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
    const found = await looked(q, limit, (close, n) =>
      customers.list(ctx, { q, limit: n, close } as Parameters<typeof customers.list>[1]));
    add({
      key: "customers", label: "Customers", more: found.more, seeAll: listed("/customers"),
      hits: found.rows.map(({ row: c, close }) => ({
        id: c.id, title: c.name, detail: c.email ?? c.phone ?? null, href: `/customers/${c.id}`, close,
      })),
    });
  }

  if (wanted("jobs", "job:read")) {
    const found = await looked(q, limit, (close, n) => jobs.list(ctx, { q, limit: n, close }));
    add({
      key: "jobs", label: "Jobs", more: found.more, seeAll: listed("/jobs"),
      hits: found.rows.map(({ row: j, close }) => ({
        id: j.id, title: `Job ${j.number}: ${j.summary}`, detail: j.customerName, href: `/jobs/${j.id}`, close,
      })),
    });
  }

  if (wanted("invoices", "invoice:read")) {
    const found = await looked(q, limit, (close, n) => billing.list(ctx, { q, limit: n, close }));
    add({
      key: "invoices", label: "Invoices", more: found.more, seeAll: listed("/invoices"),
      hits: found.rows.map(({ row: i, close }) => ({
        id: i.id, title: `Invoice ${i.number}`, detail: i.customerName, href: `/invoices/${i.id}`, close,
      })),
    });
  }

  if (wanted("estimates", "estimate:read")) {
    const found = await looked(q, limit, (close, n) => estimates.list(ctx, { q, limit: n, close }));
    add({
      key: "estimates", label: "Estimates", more: found.more, seeAll: listed("/estimates"),
      hits: found.rows.map(({ row: e, close }) => ({
        id: e.id, title: joined([`Estimate ${e.number}`, e.title], ": "), detail: e.customerName,
        href: `/estimates/${e.id}`, close,
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
    const found = await looked(q, limit, (close, n) => properties.findByStreet(ctx, { q, limit: n, close }));
    add({
      key: "addresses", label: "Addresses", more: found.more, seeAll: here("addresses"),
      hits: found.rows.map(({ row: p, close }) => ({
        id: p.id, title: joined([p.line1, p.line2], ", "),
        detail: joined([p.city, joined([p.state, p.postalCode])], ", ") || null, href: `/properties/${p.id}`, close,
      })),
    });
  }

  if (wanted("units", "equipment:read")) {
    const found = await looked(q, limit, (close, n) => equipment.findUnits(ctx, { q, limit: n, close }));
    add({
      key: "units", label: "Equipment", more: found.more, seeAll: here("units"),
      hits: found.rows.map(({ row: u, close }) => ({
        id: u.id,
        title: joined([u.tag ?? u.category, joined([u.manufacturer, u.model])], ": "),
        detail: joined([u.serialNumber ? `Serial ${u.serialNumber}` : null, u.street ? `at ${u.street}` : null]) || null,
        href: `/equipment/${u.id}`,
        close,
      })),
    });
  }

  /**
   * A note is found through its customer, under the customer's own scope,
   * and a technician finds only the notes marked for the field: exactly the
   * notes the customer's page would show them. The hit is the customer's
   * page, where the note is.
   */
  if (wanted("notes", "customer:read")) {
    const found = await looked(q, limit, (close, n) => customerNotes.find(ctx, { q, limit: n, close }));
    add({
      key: "notes", label: "Customer notes", more: found.more, seeAll: here("notes"),
      hits: found.rows.map(({ row: note, close }) => ({
        id: note.id, title: note.customerName, detail: excerpt(note.body, q), href: `/customers/${note.customerId}`, close,
      })),
    });
  }

  if (wanted("pricebook", "pricebook:read")) {
    const found = await looked(q, limit, (close, n) => pricebook.list(ctx, { q, limit: n, includeInactive: false, close }));
    add({
      key: "pricebook", label: "Price book", more: found.more, seeAll: listed("/pricebook"),
      hits: found.rows.map(({ row: item, close }) => ({
        id: item.id, title: item.name, detail: item.code ? `Code ${item.code}` : null,
        href: `/pricebook/items/${item.id}`, close,
      })),
    });
  }

  if (wanted("people", "user:read")) {
    const found = await looked(q, limit, async (close, n) => {
      const page = await people.find(ctx, { q, limit: n, close });
      return { ...page, data: page.data.map((person) => ({ ...person, id: person.membershipId })) };
    });
    add({
      key: "people", label: "People", more: found.more, seeAll: here("people"),
      hits: found.rows.map(({ row: person, close }) => ({
        id: person.id,
        title: person.name ?? person.displayName ?? person.email,
        detail: person.active ? person.email : `${person.email}, no longer here`,
        href: `/people/${person.membershipId}`,
        close,
      })),
    });
  }

  if (input.in === undefined && can(ctx.actor, "record:read")) {
    for (const kind of await customObjects.listKinds(ctx)) {
      const found = await looked(q, EACH, (close, n) => customObjects.listRecords(ctx, { type: kind.key, q, limit: n, close }));
      add({
        key: `record:${kind.key}`, label: kind.pluralLabel, more: found.more,
        seeAll: `/records/${kind.key}?${new URLSearchParams({ q })}`,
        hits: found.rows.map(({ row: r, close }) => ({
          id: r.id, title: r.title,
          detail: r.job?.name || r.customer?.name || r.equipment?.name || null,
          href: `/records/${kind.key}/${r.id}`,
          close,
        })),
      });
    }
  }
  return { q, groups };
}

export const handlers = {
  searchEverything: (ctx: ServiceContext, input: { q: string; in?: GroupKey | undefined }) => everything(ctx, input),
} as const;
