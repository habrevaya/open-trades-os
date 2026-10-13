import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { accounting, accountingBranches, accountingDeletions, branches } from "@opentradesos/api/services";
import { can, ledger } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { mapAccounts, mapBranches, retryProblem, unmapBranch } from "./actions";
import {
  AccountMappings, BranchMappings, ProblemsList, branchWord,
  type AccountRow, type BooksAccount, type BooksOption, type BooksRead, type BranchRow,
} from "./Sections";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → ACCOUNTING
 *
 * The three things the accounting sync needs a person for, which were API
 * calls with no screen: where each of the product's accounts goes in the
 * books, which class or tracking option each branch goes as, and the
 * documents the sync could not send, with the button to send one again.
 *
 * Everything needs `accounting:sync`, the permission every route here
 * declares, and goes through the same services those routes call.
 *
 * THE BOOKS ARE READ ONLY WHEN SOMEBODY ASKS. QuickBooks meters reads and
 * refuses the overage, so the chart of accounts and the list of classes are
 * read when a person presses the button that asks for them (`?read=accounts`
 * or `?read=branches`) and never on an ordinary visit. What was chosen is
 * stored with its name, so the page shows it without reading anything.
 */

const SAVED: Record<string, string> = {
  accounts: "Saved. Documents on those accounts go on the next sync.",
  branches: "Saved. From the next sync, documents in those branches go with what you chose.",
  unmapped: "That branch is sent without one from the next sync. What already went keeps what it had.",
  retried: "It goes again on the next sync.",
};

/** What a read of the books said, as a sentence somebody can act on. */
function readFailure(books: string, result: Remote): string {
  if (result.blocked) {
    const minutes = result.retryAfterSeconds ? Math.max(1, Math.ceil(result.retryAfterSeconds / 60)) : null;
    return `${books} has stopped answering reads for now, because it limits how many it answers.`
      + (minutes ? ` Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` : " Try again later.");
  }
  return `${books} could not be read: ${result.error ?? "it gave no reason"}.`;
}

type Remote = { blocked: string | null; error: string | null; retryAfterSeconds: number | null };

/**
 * One read of the books, as a list or a sentence. A read that could not even
 * start (a credential missing from the secret store, say) is said rather than
 * thrown, because the rest of the page is still worth showing.
 */
async function readBooks<T>(books: string, read: () => Promise<Remote & { list: T[] }>): Promise<BooksRead<T>> {
  try {
    const result = await read();
    if (result.blocked || result.error) return { ok: false, sentence: readFailure(books, result) };
    return { ok: true, items: result.list };
  } catch (error) {
    if (error instanceof Error && (error.name === "PermissionError" || error.name === "DemoReadOnlyError")) throw error;
    return { ok: false, sentence: `${books} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export default async function AccountingSettingsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const query = await searchParams;
  const one = (key: string) => (typeof query[key] === "string" ? query[key] : undefined);

  if (!can(user.actor, "accounting:sync")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Accounting" />
        <Empty title="Not shown to your role">
          Where your accounts go in QuickBooks or Xero, and what the sync could not send, need the Run and
          configure the accounting sync permission.
        </Empty>
      </div>
    );
  }

  const status = await accounting.status(ctx);
  if (!status.connected || !status.provider) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Accounting" />
        <Empty title="No books connected">
          Connect QuickBooks Online or Xero on{" "}
          <Link href="/settings/integrations" className="underline underline-offset-4">Settings, Integrations</Link>
          {" "}first. Then choose here where each of your accounts goes.
        </Empty>
      </div>
    );
  }

  const provider = status.provider;
  const books = accountingDeletions.booksName(provider);
  const read = one("read");
  const saved = SAVED[one("saved") ?? ""];

  const [mappings, branchMappings, problems, branchList] = await Promise.all([
    accounting.listMappings(ctx),
    accountingBranches.listBranchMappings(ctx),
    accounting.listProblems(ctx),
    branches.options(ctx),
  ]);

  /**
   * Every account the product posts to, every one a posting has used, and
   * every one already mapped. Retainage receivable is left off, as the status
   * leaves it off: nothing sent lands on it (M14).
   */
  const needed = new Set(status.unmappedAccountCodes);
  const mappedBy = new Map(mappings.map((m) => [m.accountCode, m]));
  const codes = [...new Set([
    ...Object.values(ledger.ACCOUNTS).filter((code) => code !== ledger.ACCOUNTS.RETAINAGE_RECEIVABLE),
    ...needed, ...mappedBy.keys(),
  ])].sort();
  const accountRows: AccountRow[] = codes.map((code) => ({
    code,
    name: ledger.accountName(code),
    mapped: mappedBy.get(code) ?? null,
    needed: needed.has(code),
  }));

  const branchMappedBy = new Map(branchMappings.map((m) => [m.businessUnitId, m]));
  const active = new Set(branchList.branches.map((b) => b.id));
  const branchRows: BranchRow[] = [
    ...branchList.branches.map((b) => ({ businessUnitId: b.id, name: b.name, active: true })),
    ...branchMappings.filter((m) => !active.has(m.businessUnitId))
      .map((m) => ({ businessUnitId: m.businessUnitId, name: m.branchName, active: false })),
  ].map((row) => {
    const mapped = branchMappedBy.get(row.businessUnitId);
    return {
      ...row,
      mapped: mapped
        ? { externalId: mapped.externalId, externalName: mapped.externalName, groupId: mapped.groupId, groupName: mapped.groupName }
        : null,
    };
  });

  const chart: BooksRead<BooksAccount> | null = read === "accounts"
    ? await readBooks(books, async () => {
      const result = await accounting.handlers.listAccountingAccounts(ctx);
      return { ...result, list: result.accounts };
    })
    : null;
  const options: BooksRead<BooksOption> | null = read === "branches" && branchRows.length > 0
    ? await readBooks(books, async () => {
      const result = await accountingBranches.handlers.listAccountingBranchOptions(ctx);
      return { ...result, list: result.options };
    })
    : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Accounting" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Connected to {books}.{" "}
        {status.lastRun
          ? `The last sync started ${formatIn(status.lastRun.startedAt, user.organizationTimezone)}.`
          : "It has not synced yet."}
        {" "}{status.linkedDocuments} {status.linkedDocuments === 1 ? "document has" : "documents have"} gone,
        {" "}{status.pendingDocuments} {status.pendingDocuments === 1 ? "is" : "are"} on the way, and
        {" "}{status.failedDocuments} {status.failedDocuments === 1 ? "needs" : "need"} you.
        {" "}Branches go as a {branchWord(provider)}.
      </p>
      {saved ? (
        <p role="status" className="mt-4 rounded border border-steel-200 bg-steel-100 px-3 py-2 text-sm text-ink-900">{saved}</p>
      ) : null}

      <AccountMappings books={books} rows={accountRows} chart={chart} action={mapAccounts} />
      <BranchMappings books={books} provider={provider} rows={branchRows} options={options}
                      action={mapBranches} unmap={unmapBranch} />
      <ProblemsList books={books} timezone={user.organizationTimezone} retry={retryProblem}
                    stopsAfter={accounting.MAX_ATTEMPTS}
                    problems={problems.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() }))} />
    </div>
  );
}
