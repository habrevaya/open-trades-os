import { can } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import * as customers from "./customers";
import * as jobs from "./jobs";
import * as customObjects from "./custom-objects";

/**
 * ONE BOX THAT FINDS THINGS
 *
 * Nothing here reads a table. Each part asks the service that owns its list,
 * with the caller's own context, so the scope a technician is held to on the
 * customer list, the job they may open and the kinds of record they may read
 * are exactly what this finds. A part the caller holds no permission for is
 * skipped rather than refused: the box is one screen for everybody, and a
 * refusal would say only that customers exist.
 *
 * A company's own records are the reason it exists: a permit is found by its
 * number or its street from anywhere, rather than by first remembering which
 * job it was on.
 */
export interface SearchHit { id: string; title: string; detail: string | null; href: string }
export interface SearchGroup { key: string; label: string; hits: SearchHit[] }

const EACH = 5;

export async function everything(ctx: ServiceContext, input: { q: string }): Promise<{ q: string; groups: SearchGroup[] }> {
  const q = input.q.trim();
  if (q.length < 2) return { q, groups: [] };
  const groups: SearchGroup[] = [];

  if (can(ctx.actor, "customer:read")) {
    const page = await customers.list(ctx, { q, limit: EACH } as Parameters<typeof customers.list>[1]);
    if (page.data.length > 0) {
      groups.push({
        key: "customers", label: "Customers",
        hits: page.data.map((c) => ({
          id: c.id, title: c.name, detail: c.email ?? c.phone ?? null, href: `/customers/${c.id}`,
        })),
      });
    }
  }

  /** A job by the number people say out loud, through the job's own scoped read. */
  const number = /^#?(\d{1,9})$/.exec(q)?.[1];
  if (number && can(ctx.actor, "job:read")) {
    const id = await customObjects.jobByNumber(ctx, { number: Number(number) });
    if (id) {
      const job = await jobs.get(ctx, { id });
      groups.push({
        key: "jobs", label: "Jobs",
        hits: [{ id: job.id, title: `Job ${job.number}: ${job.summary}`, detail: null, href: `/jobs/${job.id}` }],
      });
    }
  }

  if (can(ctx.actor, "record:read")) {
    for (const kind of await customObjects.listKinds(ctx)) {
      const page = await customObjects.listRecords(ctx, { type: kind.key, q, limit: EACH });
      if (page.data.length === 0) continue;
      groups.push({
        key: `record:${kind.key}`, label: kind.pluralLabel,
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
  searchEverything: (ctx: ServiceContext, input: { q: string }) => everything(ctx, input),
} as const;
