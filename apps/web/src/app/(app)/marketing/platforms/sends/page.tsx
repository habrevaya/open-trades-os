import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { adConversions } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { retrySend } from "../actions";

export const dynamic = "force-dynamic";

/**
 * EVERY JOB TOLD TO EVERY PLATFORM, AND EVERY ONE THAT WAS NOT
 *
 * The audit of the conversion sends: one row per job, per platform, per kind,
 * which is the guarantee that nothing is reported twice. A withheld row is a
 * decision made here, with the reason in words: the customer said no, there
 * was nothing to match on, the company's model gives the platform none of the
 * job. A refused row is the platform's own answer. What was sent is listed by
 * name and never by value.
 */
const STATES = ["sent", "withheld", "refused", "failed", "sending"] as const;
const KIND: Record<string, string> = { lead: "Booked (lead)", purchase: "Paid (purchase)" };
const IDENTIFIER: Record<string, string> = {
  click_id: "click", email: "email, hashed", phone: "phone, hashed", client_id: "analytics id", browser_id: "browser id",
};

export default async function SendsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const query = await searchParams;
  const state = STATES.find((s) => s === query["state"]);
  const sends = await adConversions.listSends({ actor: user.actor, db: getDb() }, { ...(state ? { state } : {}) });
  const writes = can(user.actor, "adspend:write");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Conversions sent" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        A job is sent to a platform once, only when one of its own visits or calls came from that
        platform, with that platform&rsquo;s share of the revenue under your attribution model. A
        customer who said no to their details being used for advertising has nothing sent at all.
        Back to <Link href="/marketing/platforms" className="underline underline-offset-4">Ad platforms</Link>.
      </p>
      <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">Show</span>
          <select name="state" defaultValue={state ?? ""} className="h-9 rounded border border-steel-300 px-2">
            <option value="">Everything</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium">Show</button>
      </form>

      {sends.length === 0 ? (
        <Empty title="Nothing sent yet">
          Sends start once a connected platform has a booked or paid job one of its clicks led to.
        </Empty>
      ) : (
        <Table
          label="Conversion sends"
          head={<><Th>When</Th><Th>Platform</Th><Th>What</Th><Th>Job</Th><Th>Value</Th><Th>Sent on</Th><Th>Outcome</Th></>}
        >
          {sends.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap">{formatIn(new Date(s.sentAt ?? s.createdAt), user.organizationTimezone)}</Td>
              <Td>{s.providerLabel}</Td>
              <Td>{KIND[s.kind] ?? s.kind}</Td>
              <Td>
                <Link href={`/jobs/${s.jobId}`} className="underline underline-offset-4">#{s.jobNumber ?? ""}</Link>
                {s.customerName ? <span className="block text-xs text-ink-500">{s.customerName}</span> : null}
              </Td>
              <Td>{s.value ? <Money value={s.value} /> : ""}</Td>
              <Td className="text-xs text-ink-700">{s.identifiers.map((i) => IDENTIFIER[i] ?? i).join(", ")}</Td>
              <Td>
                <Chip tone={s.state === "sent" ? "success" : s.state === "refused" || s.state === "failed" ? "danger" : "neutral"}>{s.state}</Chip>
                {s.detail ? <span className="mt-1 block text-xs text-ink-700">{s.detail}</span> : null}
                {writes && s.state !== "sent" && s.state !== "sending" && (
                  <ActionForm action={retrySend} submit="Try again" tone="quiet" hidden={{ id: s.id }} className="mt-1" />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
