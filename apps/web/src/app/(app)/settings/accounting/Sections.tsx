import Link from "next/link";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Table, Th, Td, Empty } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import type { FormState } from "@/lib/actions";

/**
 * THE THREE PARTS OF SETTINGS → ACCOUNTING, drawn from what the page read.
 *
 * Kept apart from the page so each can be rendered on its own in a test, the
 * way the other settings screens are, without a database or a book.
 */

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** What a read of the books came back with: the list, or why there is none. */
export type BooksRead<T> =
  | { ok: true; items: T[] }
  | { ok: false; sentence: string };

/** A choice as the select carries it. One function, so "unchanged" compares like with like. */
export const choiceValue = (fields: Record<string, string | null>): string => JSON.stringify(fields);

const READ_NOTE = "Each read counts against the limit QuickBooks puts on reads, so the list is read only when you ask.";

/* ---------------------------------------------------------- the accounts */

export interface AccountRow {
  code: string;
  /** The product's own name for it, or null for a code the company added. */
  name: string | null;
  mapped: { externalId: string; externalName: string; externalKind: string } | null;
  /** Postings use it and nothing on it is sent until it is mapped. */
  needed: boolean;
}

export interface BooksAccount {
  externalId: string;
  name: string;
  kind: string;
  classification: string;
  number: string | null;
  active: boolean;
}

const CLASSIFICATIONS: { key: string; label: string }[] = [
  { key: "income", label: "Income" },
  { key: "expense", label: "Expenses" },
  { key: "asset", label: "Assets" },
  { key: "liability", label: "Liabilities" },
  { key: "equity", label: "Equity" },
  { key: "other", label: "Other" },
];

const accountChoice = (a: { externalId: string; name: string; kind: string }) =>
  choiceValue({ id: a.externalId, name: a.name, kind: a.kind });

const accountLabel = (a: BooksAccount) =>
  `${a.number ? `${a.number} ` : ""}${a.name}${a.kind === "Item" ? " (product or service)" : ""}`;

export function AccountMappings({
  books, rows, chart, action,
}: {
  books: string;
  rows: AccountRow[];
  /** Null until somebody asks for the chart to be read. */
  chart: BooksRead<BooksAccount> | null;
  action: Action;
}) {
  const needed = rows.filter((r) => r.needed).length;
  const goesTo = (row: AccountRow) => row.mapped
    ? <span>{row.mapped.externalName}{row.mapped.externalKind === "Item" ? <span className="text-ink-500"> (product or service)</span> : null}</span>
    : <span className="text-ink-500">Not mapped</span>;
  const ours = (row: AccountRow) => (
    <>
      <span className="font-mono">{row.code}</span>
      {row.name ? <span className="ml-2">{row.name}</span> : null}
      {row.needed ? <Chip tone="warning" className="ml-2">Needed</Chip> : null}
    </>
  );

  return (
    <section id="accounts" aria-label="Where each account goes" className="mt-8">
      <h2 className="text-base font-semibold">Where each account goes in {books}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">
        Every amount here is posted to one of these accounts. Tell us which account in {books} each one goes to.
        Nothing is guessed: a document on an account that is not mapped waits, and shows below with the account
        it needs.
        {needed > 0 ? ` ${needed} ${needed === 1 ? "account is" : "accounts are"} needed now.` : ""}
      </p>

      {chart === null ? (
        <>
          <Table label="Account mappings" head={<><Th>Our account</Th><Th>Goes to</Th></>}>
            {rows.map((row) => (
              <tr key={row.code}><Td>{ours(row)}</Td><Td>{goesTo(row)}</Td></tr>
            ))}
          </Table>
          <p className="mt-3 text-sm">
            <a href="/settings/accounting?read=accounts#accounts"
               className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
              Read the accounts from {books} to change these
            </a>
          </p>
          <p className="mt-1 text-xs text-ink-500">{READ_NOTE}</p>
        </>
      ) : !chart.ok ? (
        <p role="alert" className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{chart.sentence}</p>
      ) : (
        <ActionForm action={action} submit="Save the mappings" className="mt-3 space-y-3">
          <Table label="Account mappings" head={<><Th>Our account</Th><Th>Goes to now</Th><Th>Goes to</Th></>}>
            {rows.map((row) => {
              const current = row.mapped
                ? chart.items.find((a) => a.externalId === row.mapped!.externalId && a.kind === row.mapped!.externalKind)
                : undefined;
              const was = current ? accountChoice(current) : row.mapped ? accountChoice({
                externalId: row.mapped.externalId, name: row.mapped.externalName, kind: row.mapped.externalKind,
              }) : "";
              return (
                <tr key={row.code}>
                  <Td>{ours(row)}</Td>
                  <Td>{goesTo(row)}</Td>
                  <Td>
                    <input type="hidden" name={`was:${row.code}`} value={was} />
                    <select name={`account:${row.code}`} defaultValue={was} aria-label={`Account ${row.code} goes to`}
                            className="h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm">
                      {row.mapped ? null : <option value="">Not mapped</option>}
                      {row.mapped && !current ? (
                        <option value={was}>{row.mapped.externalName} (no longer in {books})</option>
                      ) : null}
                      {CLASSIFICATIONS.map((group) => {
                        const inGroup = chart.items.filter((a) => a.classification === group.key
                          && (a.active || a === current));
                        return inGroup.length === 0 ? null : (
                          <optgroup key={group.key} label={group.label}>
                            {inGroup.map((a) => (
                              <option key={`${a.kind}:${a.externalId}`} value={accountChoice(a)}>{accountLabel(a)}</option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </Td>
                </tr>
              );
            })}
          </Table>
          <p className="text-xs text-ink-500">
            Read from {books} just now. Changing where an account goes changes where everything sent from now on
            lands; what was already sent stays where it went.
          </p>
        </ActionForm>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- the branches */

export interface BranchRow {
  businessUnitId: string;
  name: string;
  /** A retired branch is listed only while it is still mapped. */
  active: boolean;
  mapped: { externalId: string; externalName: string; groupId: string | null; groupName: string | null } | null;
}

export interface BooksOption {
  externalId: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  active: boolean;
}

/** QuickBooks calls it a class and Xero an option of a tracking category. */
export function branchWord(provider: string): string {
  return provider === "quickbooks" ? "class" : provider === "xero" ? "tracking option" : "class or tracking option";
}

const optionChoice = (o: { externalId: string; name: string; groupId: string | null; groupName: string | null }) =>
  choiceValue({ id: o.externalId, name: o.name, groupId: o.groupId, groupName: o.groupName });

const optionLabel = (o: { name: string; groupName: string | null }) => (o.groupName ? `${o.groupName}: ${o.name}` : o.name);

export function BranchMappings({
  books, provider, rows, options, action, unmap,
}: {
  books: string;
  provider: string;
  rows: BranchRow[];
  /** Null until somebody asks for the list to be read. */
  options: BooksRead<BooksOption> | null;
  action: Action;
  unmap: Action;
}) {
  const word = branchWord(provider);
  const goesTo = (row: BranchRow) => row.mapped
    ? <span>{optionLabel({ name: row.mapped.externalName, groupName: row.mapped.groupName })}</span>
    : <span className="text-ink-500">Sent without one</span>;
  const branch = (row: BranchRow) => (
    <>{row.name}{row.active ? null : <Chip tone="neutral" className="ml-2">Retired</Chip>}</>
  );

  return (
    <section id="branches" aria-label="Branches in the books" className="mt-10">
      <h2 className="text-base font-semibold">Branches in {books}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">
        Optional. Give a branch a {word} and, from the next sync, its invoices, credit notes, write offs, refunds
        and journal lines go to {books} with it, so you can read your books by branch there too. A branch with no
        {" "}{word} is sent as before. Payments go without one, because {books} has no place for it on a payment.
        {provider === "quickbooks"
          ? " In QuickBooks, turn on Track classes and set it to one class for each row in a transaction."
          : ""}
      </p>

      {rows.length === 0 ? (
        <Empty title="No branches">
          This company has no branches to send. Add them on <Link href="/settings/branches" className="underline underline-offset-4">Settings, Branches</Link>.
        </Empty>
      ) : options === null ? (
        <>
          <Table label="Branch mappings" head={<><Th>Branch</Th><Th>Goes to {books} as</Th><Th>{""}</Th></>}>
            {rows.map((row) => (
              <tr key={row.businessUnitId}>
                <Td>{branch(row)}</Td>
                <Td>{goesTo(row)}</Td>
                <Td>
                  {row.mapped ? (
                    <ActionForm action={unmap} submit={`Stop sending ${row.name}`} tone="quiet"
                                hidden={{ businessUnitId: row.businessUnitId }} className="flex items-center gap-2" />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-sm">
            <a href="/settings/accounting?read=branches#branches"
               className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
              Read the {word === "class" ? "classes" : `${word}s`} from {books} to change these
            </a>
          </p>
          {provider === "quickbooks" ? <p className="mt-1 text-xs text-ink-500">{READ_NOTE}</p> : null}
        </>
      ) : !options.ok ? (
        <p role="alert" className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">{options.sentence}</p>
      ) : (
        <ActionForm action={action} submit="Save the branches" className="mt-3 space-y-3">
          <Table label="Branch mappings" head={<><Th>Branch</Th><Th>Goes now as</Th><Th>Goes to {books} as</Th></>}>
            {rows.map((row) => {
              const current = row.mapped
                ? options.items.find((o) => o.externalId === row.mapped!.externalId && o.groupId === row.mapped!.groupId)
                : undefined;
              const was = current ? optionChoice(current) : row.mapped ? optionChoice({
                externalId: row.mapped.externalId, name: row.mapped.externalName,
                groupId: row.mapped.groupId, groupName: row.mapped.groupName,
              }) : "";
              return (
                <tr key={row.businessUnitId}>
                  <Td>{branch(row)}</Td>
                  <Td>{goesTo(row)}</Td>
                  <Td>
                    <input type="hidden" name={`was:${row.businessUnitId}`} value={was} />
                    <select name={`branch:${row.businessUnitId}`} defaultValue={was} aria-label={`${row.name} goes as`}
                            className="h-9 w-full rounded border border-steel-300 bg-canvas px-2 text-sm">
                      {row.mapped ? null : <option value="">Sent without one</option>}
                      {row.mapped && !current ? (
                        <option value={was}>{optionLabel({ name: row.mapped.externalName, groupName: row.mapped.groupName })} (no longer in {books})</option>
                      ) : null}
                      {options.items.filter((o) => o.active || o === current).map((o) => (
                        <option key={`${o.groupId ?? ""}:${o.externalId}`} value={optionChoice(o)}>{optionLabel(o)}</option>
                      ))}
                    </select>
                  </Td>
                </tr>
              );
            })}
          </Table>
          {options.items.length === 0 ? (
            <p className="text-sm text-ink-700">
              {books} has no {word === "class" ? "classes" : `${word}s`} yet. Add them there, then read them again.
            </p>
          ) : null}
          <p className="text-xs text-ink-500">
            Read from {books} just now. To stop sending a branch, save, then use Stop sending beside it.
          </p>
        </ActionForm>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- the problems */

export interface Problem {
  id: string;
  kind: string;
  entityId: string;
  idempotencyKey: string;
  state: "failed" | "deleted";
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

/** What each kind of document is, in words, and where its own page is when it has one. */
export function problemRecord(problem: Pick<Problem, "kind" | "entityId" | "idempotencyKey">): { what: string; href: string | null } {
  const key = problem.idempotencyKey;
  switch (problem.kind) {
    case "customer": return { what: `Customer ${key}`, href: `/customers/${problem.entityId}` };
    case "invoice": return { what: `Invoice ${key}`, href: `/invoices/${problem.entityId}` };
    case "credit_memo": return { what: `Void or write off of an invoice (${key})`, href: `/invoices/${problem.entityId}` };
    case "payment": return { what: `A payment (${key})`, href: null };
    case "refund": return { what: `A refund (${key})`, href: null };
    case "credit_note": return { what: `Credit note (${key})`, href: `/invoices/credit-notes/${problem.entityId}` };
    case "credit_note_void": return { what: `A voided credit note (${key})`, href: `/invoices/credit-notes/${problem.entityId}` };
    case "credit_note_application": return { what: `A credit note used on an invoice (${key})`, href: null };
    case "credit_note_refund": return { what: `Credit paid back to a customer (${key})`, href: null };
    case "journal": return { what: `Journal entry (${key})`, href: "/books" };
    default: return { what: key, href: null };
  }
}

/** Where a document on the list stands, in words, and whether sending it again would do anything. */
export function problemState(p: Pick<Problem, "state" | "attempts" | "lastError">, books: string, stopsAfter: number):
  { tone: "warning" | "danger" | "info"; said: string; retry: boolean } {
  if (p.state === "deleted") return { tone: "warning", said: `Deleted in ${books}`, retry: true };
  if (p.attempts === 0 && p.lastError === null) return { tone: "info", said: "Goes again on the next sync", retry: false };
  if (p.attempts >= stopsAfter) return { tone: "danger", said: `Stopped after ${p.attempts} tries`, retry: true };
  return { tone: "warning", said: "Refused, and tried again on each sync", retry: true };
}

export function ProblemsList({
  books, problems, timezone, retry, stopsAfter,
}: {
  books: string;
  problems: Problem[];
  timezone: string;
  retry: Action;
  /** How many times the sync offers a document before it stops (`MAX_ATTEMPTS`). */
  stopsAfter: number;
}) {
  return (
    <section id="problems" aria-label="Documents that did not go" className="mt-10">
      <h2 className="text-base font-semibold">Documents that did not go to {books}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">
        A document {books} refused is listed here with the reason, and offered again on each sync until it has
        been tried {stopsAfter} times; one deleted in {books} after it went is listed too. Put the reason right (often an account to map above), then send
        it again. Sending again cannot put it in {books} twice.
      </p>
      {problems.length === 0 ? (
        <Empty title="Nothing waiting">Every document the sync has tried has gone to {books}.</Empty>
      ) : (
        <Table label="Documents that did not go" head={
          <><Th>Document</Th><Th>What happened</Th><Th>Last tried</Th><Th>{""}</Th></>
        }>
          {problems.map((p) => {
            const record = problemRecord(p);
            const stands = problemState(p, books, stopsAfter);
            return (
              <tr key={p.id}>
                <Td>
                  {record.href
                    ? <a href={record.href} className="underline underline-offset-4">{record.what}</a>
                    : record.what}
                </Td>
                <Td>
                  <Chip tone={stands.tone}>{stands.said}</Chip>
                  {p.lastError ? <span className="mt-1 block text-sm text-ink-700">{p.lastError}</span> : null}
                </Td>
                <Td className="whitespace-nowrap">{formatIn(p.updatedAt, timezone)}</Td>
                <Td>
                  {stands.retry ? (
                    <ActionForm action={retry} submit="Send it again" tone="quiet" hidden={{ linkId: p.id }}
                                className="flex items-center gap-2" />
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </section>
  );
}
