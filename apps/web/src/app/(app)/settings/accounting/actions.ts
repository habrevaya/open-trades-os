"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accounting, accountingBranches } from "@opentradesos/api/services";
import { setAccountMapping, setAccountingBranchMapping } from "@opentradesos/api/contracts";
import { attempt, field, parsed, refused, refusalOf, type FormState } from "@/lib/actions";

/**
 * SETTINGS → ACCOUNTING, THE WRITES
 *
 * Each goes through the service the API uses, so the permission
 * (`accounting:sync`), the audit entry and the refusals are the same ones.
 *
 * EVERY ONE ENDS ON THE PLAIN PAGE. The chart of accounts and the list of
 * classes are read from the books only when somebody presses the button that
 * asks for them, because QuickBooks meters reads and refuses the overage. A
 * save that refreshed the page it was made on would refresh `?read=accounts`
 * and spend those reads again for nobody, so each one sends the browser to
 * the page without it, saying what was saved.
 */
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const PATH = "/settings/accounting";

/** What the select carries: the choice as the books named it, frozen so nothing is read again to save it. */
function choiceOf(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsedValue: unknown = JSON.parse(value);
    return parsedValue && typeof parsedValue === "object" ? parsedValue as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Every account whose choice changed, in one go, from the form the chart was
 * read into. A refusal names the code it stopped at; the ones before it are
 * saved, and the page says so.
 */
export async function mapAccounts(_previous: FormState, form: FormData): Promise<FormState> {
  const context = await ctx();
  let saved = 0;
  const changes: { accountCode: string; choice: Record<string, unknown> }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("account:") || typeof value !== "string" || value === "") continue;
    const accountCode = name.slice("account:".length);
    if (value === (field(form, `was:${accountCode}`) ?? "")) continue;
    const choice = choiceOf(value);
    if (!choice) return refused(form, `Choose an account for ${accountCode} from the list.`);
    changes.push({ accountCode, choice });
  }
  for (const change of changes) {
    const state = await attempt(form, async () => {
      await accounting.setMapping(context, parsed(setAccountMapping.input, {
        accountCode: change.accountCode,
        externalId: change.choice["id"],
        externalName: change.choice["name"],
        externalKind: change.choice["kind"],
      }));
    });
    if (state?.error) {
      if (saved > 0) revalidatePath(PATH);
      return { ...state, error: `${change.accountCode}: ${state.error}${saved > 0 ? ` The ${saved} before it ${saved === 1 ? "was" : "were"} saved.` : ""}` };
    }
    saved += 1;
  }
  revalidatePath(PATH);
  redirect("/settings/accounting?saved=accounts#accounts");
}

/** Every branch whose class or tracking option changed, the same way. */
export async function mapBranches(_previous: FormState, form: FormData): Promise<FormState> {
  const context = await ctx();
  let saved = 0;
  const changes: { businessUnitId: string; choice: Record<string, unknown> }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("branch:") || typeof value !== "string" || value === "") continue;
    const businessUnitId = name.slice("branch:".length);
    if (value === (field(form, `was:${businessUnitId}`) ?? "")) continue;
    const choice = choiceOf(value);
    if (!choice) return refused(form, "Choose a class or tracking option from the list.");
    changes.push({ businessUnitId, choice });
  }
  for (const change of changes) {
    const group = typeof change.choice["groupId"] === "string" ? change.choice : null;
    const state = await attempt(form, async () => {
      await accountingBranches.setBranchMapping(context, parsed(setAccountingBranchMapping.input, {
        businessUnitId: change.businessUnitId,
        externalId: change.choice["id"],
        externalName: change.choice["name"],
        ...(group ? { groupId: group["groupId"], groupName: group["groupName"] } : {}),
      }));
    });
    if (state?.error) {
      if (saved > 0) revalidatePath(PATH);
      return { ...state, error: `${state.error}${saved > 0 ? ` The ${saved} before it ${saved === 1 ? "was" : "were"} saved.` : ""}` };
    }
    saved += 1;
  }
  revalidatePath(PATH);
  redirect("/settings/accounting?saved=branches#branches");
}

/** Stop sending a branch as a class. What was already sent keeps the class it went with. */
export async function unmapBranch(_previous: FormState, form: FormData): Promise<FormState> {
  const context = await ctx();
  const state = await attempt(form, async () => {
    await accountingBranches.removeBranchMapping(context, { businessUnitId: field(form, "businessUnitId") ?? "" });
  });
  if (state?.error) return state;
  revalidatePath(PATH);
  redirect("/settings/accounting?saved=unmapped#branches");
}

/**
 * Offer a document the sync stopped on again. The same call as the retry
 * route and the button beside a deleted journal: the attempts start again
 * under the same claim, so it cannot reach the books twice.
 */
export async function retryProblem(_previous: FormState, form: FormData): Promise<FormState> {
  const context = await ctx();
  const state = await attempt(form, async () => {
    await accounting.retryDocument(context, { linkId: field(form, "linkId") ?? "" });
  });
  if (state?.error) return state;
  revalidatePath(PATH);
  redirect("/settings/accounting?saved=retried#problems");
}

/**
 * Run one sync pass now, the same call as `POST /v1/accounting/sync`, and go
 * to what it sent and refused. The claims make a second press harmless: a
 * document already in the books is passed over, never sent again.
 *
 * A pass that fails part way records that on its run and comes back, so
 * the history says so. What cannot even start (the books' credential gone
 * from the secret store, say) is said here rather than thrown, as a read of
 * the books on the page is.
 */
export async function syncNow(_previous: FormState, form: FormData): Promise<FormState> {
  const context = await ctx();
  let runId: string | null = null;
  try {
    const outcome = await accounting.handlers.runAccountingSync(context, {});
    runId = outcome.runId;
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== null) return refused(form, refusal);
    return refused(form, `The sync could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  revalidatePath(PATH);
  redirect(`/settings/accounting?saved=synced&run=${runId}#runs`);
}
