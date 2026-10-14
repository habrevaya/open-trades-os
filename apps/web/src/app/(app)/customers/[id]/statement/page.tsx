import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, statements, statementDelivery, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { enumText } from "@/lib/labels";
import { emailStatement, setMonthlyCopy, textStatement } from "./actions";
import { Crumb } from "@/components/Detail";
import { PrintButton } from "@/components/PrintButton";
import { StatementView } from "@/components/Statement";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A customer's statement, for a period the office picks. GET, so a period is
 * a link somebody can send to a colleague and the browser's back button works.
 */
export default async function StatementPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const query = await searchParams;
  const from = query.from && DATE.test(query.from) ? query.from : undefined;
  const to = query.to && DATE.test(query.to) ? query.to : undefined;

  let refusal: string | null = null;
  const ctx = { actor: user.actor, db: getDb() };
  const statement = await statements.statement(ctx, { id, ...(from ? { from } : {}), ...(to ? { to } : {}) })
    .catch(async (error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      if (error instanceof Error && error.name === "UnprocessableError") {
        refusal = error.message;
        return statements.statement(ctx, { id });
      }
      throw error;
    });

  /**
   * The address on file, for the box to say where it will go when left
   * empty. Read only for somebody who may read customers: the finance role
   * may send a statement without holding the customer list, and then the box
   * simply says "the address on file".
   */
  const record = can(user.actor, "customer:read") ? await customers.get(ctx, { id }).catch(() => null) : null;
  const onFile = record?.email ?? null;
  const sent = await statementDelivery.deliveries(ctx, { customerId: id, limit: 5 });
  const sends = can(user.actor, "invoice:send");
  /** The customer's own people a copy can go to, and who every monthly statement is copied to now. */
  const copies = await statementDelivery.statementCopies(ctx, { id });
  const copyChoices = [
    { value: "", label: "Nobody" },
    ...copies.candidates.map((c) => ({ value: c.id, label: `${c.name} (${c.email})` })),
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Crumb href={`/customers/${id}`}>{statement.customerName}</Crumb>
        <div className="flex items-center gap-3">
          <a href={`/customers/${id}/statement/pdf?from=${statement.from}&to=${statement.to}`}
             className="text-sm underline underline-offset-4">Download PDF</a>
          <PrintButton label="Print statement" />
        </div>
      </div>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 print:hidden">
        <label className="block text-sm">
          <span className="font-medium text-ink-700">From</span>
          <input type="date" name="from" defaultValue={statement.from}
                 className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-ink-700">To</span>
          <input type="date" name="to" defaultValue={statement.to}
                 className="mt-1 h-10 rounded border border-steel-300 bg-canvas px-3 text-sm" />
        </label>
        <button type="submit" className="h-10 rounded bg-ink-900 px-3 text-sm font-medium text-white">Show</button>
      </form>
      {refusal && <p role="alert" className="mt-3 text-sm text-red-600">{refusal}. Showing the last ninety days instead.</p>}
      {sends && (
        <section className="mt-6 rounded-md border border-steel-200 bg-canvas p-4 print:hidden" aria-label="Email statement">
          <h2 className="text-sm font-medium text-ink-700">Email this statement</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            The email carries a link to this statement on the customer&apos;s own account page, for these dates,
            and no amounts: the page shows what they owe when they open it.
          </p>
          <ActionForm
            action={emailStatement} submit="Email statement" className="mt-3 flex flex-wrap items-end gap-3"
            hidden={{ id, from: statement.from, to: statement.to }}
          >
            <TextField label="Email address" name="email" type="email" className="block w-72"
                       placeholder={onFile ?? "The address on file"} />
            {copies.candidates.length > 0 ? (
              <Select label="Also send a copy to" name="copyContactId" options={copyChoices} defaultValue=""
                      className="block w-72" />
            ) : null}
          </ActionForm>
          <p className="mt-1 text-xs text-ink-500">
            A copy goes only to one of this customer&apos;s own people with an email address, as an email of its own.
            {copies.candidates.length === 0 ? " Nobody on this customer has an email address yet." : ""}
          </p>
          <h2 className="mt-5 text-sm font-medium text-ink-700">Or text it</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            The same link by text, to their main contact&apos;s mobile or the number on file. A number that asked not
            to be texted is not texted, and this says so.
          </p>
          <ActionForm
            action={textStatement} submit="Text statement" className="mt-3 flex flex-wrap items-end gap-3"
            hidden={{ id, from: statement.from, to: statement.to }}
          >
            <TextField label="Mobile number" name="phone" type="tel" className="block w-72"
                       placeholder={record?.phone ?? "The number on file"} />
          </ActionForm>
          <h2 className="mt-5 text-sm font-medium text-ink-700">Every month</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            When monthly statements are on, each one this customer is sent can be copied to one of their own people
            as well, by email, whichever way the statement goes.
          </p>
          <p className="mt-1 text-sm text-ink-700">
            {copies.monthly
              ? copies.monthly.usable
                ? `Copied to ${copies.monthly.name} (${copies.monthly.email}).`
                : `Named for the copy: ${copies.monthly.name}, who is no longer on this customer or has no email address. No copy goes until you choose again.`
              : "Copied to nobody."}
          </p>
          <ActionForm action={setMonthlyCopy} submit="Save the monthly copy" tone="quiet"
                      className="mt-2 flex flex-wrap items-end gap-3" hidden={{ id }}>
            <Select label="Copy each monthly statement to" name="contactId" options={copyChoices}
                    defaultValue={copies.monthly?.usable ? copies.monthly.contactId : ""} className="block w-72" />
          </ActionForm>
          {sent.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-sm text-ink-700" aria-label="Statements already sent">
              {sent.map((row) => (
                <li key={row.id}>
                  {formatIn(row.createdAt, user.organizationTimezone)}, {row.channel === "sms" ? "texted" : "emailed"} to{" "}
                  {row.destination ?? "no address"}:{" "}
                  {row.error ? <span className="text-red-600">not sent. {row.error}</span> : enumText(row.messageStatus ?? "queued")}
                  {row.note ? <span className="text-ink-500"> {row.note}</span> : null}
                  {row.copyError ? (
                    <span className="text-ink-500"> No copy: {row.copyError}</span>
                  ) : row.copyDestination ? (
                    <span className="text-ink-500">
                      {" "}Copy to {row.copyContactName ?? "a contact"} at {row.copyDestination}: {enumText(row.copyMessageStatus ?? "queued")}.
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="mt-8">
        <StatementView statement={statement} timezone={user.organizationTimezone} invoiceHref={(invoiceId) => `/invoices/${invoiceId}`} />
      </div>
    </div>
  );
}
