import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { formatDay } from "@/lib/dates";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE AGREEMENT BOOK
 *
 * The single biggest lever on what a home services company is worth. A shop
 * with four hundred members on auto renew sells for a different multiple than
 * an identical shop doing the same revenue in one off calls.
 *
 * Two numbers at the top and one list below them, and the list is the one
 * that matters: visits the company owes and has not booked. An agreement
 * whose visits quietly do not get delivered is an agreement that does not
 * renew, and the first anybody hears of it is the customer saying they never
 * saw us.
 */
const STATUS_TONE = {
  active: "success", pending: "info", past_due: "warning", paused: "neutral",
  lapsed: "neutral", cancelled: "neutral", completed: "neutral",
} as const;

export default async function AgreementsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "membership:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Agreements" />
        <Empty title="Agreements are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [book, owed, unearned, plans] = await Promise.all([
    agreements.list(ctx),
    agreements.owed(ctx),
    agreements.unearned(ctx),
    agreements.plans(ctx),
  ]);

  const active = book.filter((row) => row.agreement.status === "active");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Agreements" count={book.length} />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-steel-200 bg-canvas p-4">
          <p className="text-sm text-ink-500">On the books</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{active.length}</p>
        </div>
        <div className="rounded-md border border-steel-200 bg-canvas p-4">
          <p className="text-sm text-ink-500">Owed and unbooked</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${owed.length > 0 ? "text-red-600" : ""}`}>
            {owed.length}
          </p>
        </div>
        <div className="rounded-md border border-steel-200 bg-canvas p-4">
          {/*
            The number a company recognising agreement revenue on receipt
            does not have. It is a liability: money billed and not yet
            earned, and it belongs on a balance sheet.
          */}
          <p className="text-sm text-ink-500">Billed, not yet earned</p>
          <p className="mt-1 text-2xl font-semibold"><Money value={unearned} /></p>
        </div>
      </div>

      <h2 className="mt-8 text-sm font-medium text-ink-700">Visits we owe</h2>
      {owed.length === 0 ? (
        <Empty title="Nothing is owed in the next month">
          Included visits appear here as they come due, from the moment an
          agreement is sold rather than when somebody remembers.
        </Empty>
      ) : (
        <Table head={<><Th>Due</Th><Th>Customer</Th><Th>Plan</Th><Th>Visit</Th></>}>
          {owed.map((row) => (
            <tr key={row.visit.id}>
              <Td className="tabular-nums">{formatDay(row.visit.dueOn, user.organizationTimezone)}</Td>
              <Td>
                <a href={`/agreements/${row.agreementId}`} className="font-medium hover:underline">
                  {row.customerName}
                </a>
              </Td>
              <Td className="text-ink-700">{row.planName}</Td>
              <Td className="text-ink-500">{row.visit.sequence}</Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 text-sm font-medium text-ink-700">The book</h2>
      {book.length === 0 ? (
        <Empty title="Nobody is on a plan yet">
          {plans.length === 0
            ? "Start with a plan: a price, a term, and how many visits it includes."
            : `${plans.length} plan${plans.length === 1 ? "" : "s"} defined, and nobody sold one yet.`}
        </Empty>
      ) : (
        <Table head={<><Th>Customer</Th><Th>Plan</Th><Th>Started</Th><Th>State</Th><Th className="text-right">Price</Th></>}>
          {book.map((row) => (
            <tr key={row.agreement.id}>
              <Td>
                <a href={`/agreements/${row.agreement.id}`} className="font-medium hover:underline">
                  {row.customerName}
                </a>
              </Td>
              <Td className="text-ink-700">{row.planName}</Td>
              <Td className="tabular-nums">{formatDay(row.agreement.startedOn, user.organizationTimezone)}</Td>
              <Td>
                <Chip tone={STATUS_TONE[row.agreement.status]}>
                  {row.agreement.status.replace(/_/g, " ")}
                </Chip>
              </Td>
              <Td className="text-right"><Money value={row.agreement.price} /></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
