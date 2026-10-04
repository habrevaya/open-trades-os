import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadEmails } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * EVERY EMAIL THE LEAD INBOX RECEIVED
 *
 * The ones that became leads link to them. The ones that did not are the
 * point of this page: an email that could not be read says why and shows
 * its words, because it may be a lead with no number on it, a platform that
 * changed its layout, or the code a mailbox sends to confirm a forwarding
 * rule, which somebody setting the rule up needs to read here.
 */
const OUTCOME: Record<string, { label: string; tone: "success" | "info" | "neutral" | "warning" }> = {
  lead: { label: "Became a lead", tone: "success" },
  message: { label: "Added to a lead's conversation", tone: "info" },
  duplicate: { label: "A lead already here", tone: "neutral" },
  unreadable: { label: "Could not be read", tone: "warning" },
};

export default async function LeadEmailsPage() {
  const user = await requireSetupUser();
  const emails = await leadEmails.list({ actor: user.actor, db: getDb() }, { limit: 200 });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/leads">Lead offers</Crumb>
      <PageHeader title="Lead emails" count={emails.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What arrived at the lead inbox. The address is on{" "}
        <a href="/marketing/leads/connectors" className="underline underline-offset-4">Lead sources</a>.
      </p>
      {emails.length === 0 ? (
        <Empty title="Nothing yet">Forward a marketplace&apos;s lead email to the lead inbox and it appears here.</Empty>
      ) : (
        <Table label="Lead emails" head={<><Th>Arrived</Th><Th>From</Th><Th>What happened</Th><Th>What it said</Th></>}>
          {emails.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap">{formatIn(e.receivedAt, user.organizationTimezone)}</Td>
              <Td>
                {e.platformLabel ?? "Not a marketplace"}
                <span className="block text-xs text-ink-500">{e.from}</span>
              </Td>
              <Td>
                <Chip tone={OUTCOME[e.outcome]?.tone ?? "neutral"}>{OUTCOME[e.outcome]?.label ?? e.outcome}</Chip>
                {e.offerId ? <a href={`/marketing/leads/${e.offerId}`} className="mt-1 block text-sm underline underline-offset-4">The lead</a> : null}
                {e.reason ? <span className="mt-1 block text-xs text-ink-700">{e.reason}</span> : null}
              </Td>
              <Td>
                <span className="font-medium">{e.subject ?? "(no subject)"}</span>
                {e.outcome === "unreadable" && e.excerpt
                  ? <span className="mt-1 block max-w-md whitespace-pre-line text-xs text-ink-700">{e.excerpt.slice(0, 800)}</span>
                  : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
