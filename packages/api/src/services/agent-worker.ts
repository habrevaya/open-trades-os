import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { inTenant, type ServiceContext } from "./context";
import * as base from "./agents";
import * as intake from "./agent-intake";
import * as chat from "./agent-chat";
import * as collections from "./agent-collections";
import type { AiDeps } from "./ai";

/**
 * THE AGENTS THAT RUN WITH NOBODY WATCHING
 *
 * On the worker's clock, for every company that turned an agent on and chose
 * who it acts as: intake reads what arrived since it was turned on, the chat
 * agent answers texts waiting for it, and collections looks for invoices due a
 * reminder once an hour. Each step has its own try, so a model vendor that is
 * down for one company does not hold up another, and a failed step is retried
 * on a later pass.
 *
 * SMALL BATCHES. Every item here is a model call on the company's own bill,
 * so a pass takes a few per company and leaves the rest for the next pass. A
 * backlog drains over minutes rather than spending a month's ceiling in one
 * go, and the agent's own daily limit stops it either way.
 */

const reader = (db: Database, organizationId: string): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [] },
  db,
});

export interface AgentPassResult {
  organizationId: string;
  drafted: number;
  answered: number;
  reminders: number;
  /** Whether anything went into the outbox, so the worker sends it on this pass. */
  queued: boolean;
  failed: string[];
}

/**
 * Claim this hour's collections check for a company, at most once an hour.
 *
 * The claim is the update itself, so two workers running side by side cannot
 * both check, and a pass that crashed after claiming simply waits an hour.
 */
async function claimHourly(tx: Database, organizationId: string, now: Date): Promise<boolean> {
  const claimed = await tx.update(schema.aiAgentSetting)
    .set({ settings: sql`${schema.aiAgentSetting.settings} || jsonb_build_object('lastPassAt', ${now.toISOString()}::text)` })
    .where(and(
      eq(schema.aiAgentSetting.organizationId, organizationId),
      eq(schema.aiAgentSetting.agent, "collections"),
      sql`coalesce((${schema.aiAgentSetting.settings} ->> 'lastPassAt')::timestamptz, '-infinity'::timestamptz)
          < ${new Date(now.getTime() - 3600_000).toISOString()}::timestamptz`,
    )).returning({ id: schema.aiAgentSetting.id });
  return claimed.length > 0;
}

export async function passFor(db: Database, organizationId: string, deps: AiDeps = base.DEFAULT_AGENT_DEPS): Promise<AgentPassResult> {
  const result: AgentPassResult = { organizationId, drafted: 0, answered: 0, reminders: 0, queued: false, failed: [] };
  const now = (deps.now ?? (() => new Date()))();

  try {
    const work = await inTenant(reader(db, organizationId), async (tx) => {
      const settings = await base.settingWithin(tx, organizationId, "intake");
      const since = await base.enabledSince(tx, organizationId, "intake");
      if (!settings.enabled || !settings.runAsUserId || !since) return [];
      return intake.pending(tx, organizationId, since, settings, 3);
    });
    for (const source of work) {
      const outcome = await intake.run(db, organizationId, source, { deps });
      if (outcome.draft) result.drafted += 1;
      else if (outcome.reason) break;
    }
  } catch (error) {
    result.failed.push(`intake: ${(error as Error).message}`);
  }

  try {
    const texts = await chat.answerTexts(db, organizationId, deps, 3);
    result.answered = texts.answered;
    if (texts.answered > 0) result.queued = true;
  } catch (error) {
    result.failed.push(`chat: ${(error as Error).message}`);
  }

  try {
    const due = await inTenant(reader(db, organizationId), async (tx) => {
      const settings = await base.settingWithin(tx, organizationId, "collections");
      if (!settings.enabled || !settings.runAsUserId) return false;
      return claimHourly(tx, organizationId, now);
    });
    if (due) {
      const outcome = await collections.run(db, organizationId, { deps, limit: 5 });
      result.reminders = outcome.drafted;
      if (outcome.sent > 0) result.queued = true;
    }
  } catch (error) {
    result.failed.push(`collections: ${(error as Error).message}`);
  }
  return result;
}

/** Every company with an agent running on its own, a few items each. */
export async function agentPass(
  db: Database, options: { shouldStop?: () => boolean; deps?: AiDeps; limit?: number } = {},
): Promise<AgentPassResult[]> {
  const rows = await db.execute<{ organization_id: string }>(
    sql`select organization_id from app.ai_agent_organizations(${options.limit ?? 200})`,
  );
  const out: AgentPassResult[] = [];
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    out.push(await passFor(db, row.organization_id, options.deps));
  }
  return out;
}
