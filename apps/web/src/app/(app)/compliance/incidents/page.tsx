import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safety } from "@opentradesos/api/services";
import { can, safety as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * INCIDENT REPORTS
 *
 * The register for whoever runs safety: everything reported, newest first,
 * open ones marked. Somebody who can report and not read the register sees
 * their own reports here and nobody else's, so they can check theirs went in.
 *
 * Nothing on this screen says whether an incident must be reported to an
 * authority. That depends on facts the product does not hold.
 */
export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;
  const register = can(user.actor, "safety:read");

  if (!register && !can(user.actor, "safety:report")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Incidents" />
        <Empty title="Safety records are not part of your access">Somebody who can change roles can turn this on.</Empty>
      </div>
    );
  }

  const { status } = await searchParams;
  const chosen = status === "open" || status === "closed" ? status : undefined;
  const incidents = await safety.listIncidents(ctx, chosen ? { status: chosen } : {});

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title={register ? "Incidents" : "Incidents you reported"} count={incidents.length} />
      <p className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <a href="/compliance/incidents/new"
           className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 font-medium text-white hover:bg-ink-700">
          Report an incident or near miss
        </a>
        <a href="/compliance/incidents" className="text-blue-600 underline underline-offset-4">All</a>
        <a href="/compliance/incidents?status=open" className="text-blue-600 underline underline-offset-4">Open</a>
        <a href="/compliance/incidents?status=closed" className="text-blue-600 underline underline-offset-4">Closed</a>
      </p>

      {incidents.length === 0 ? (
        <Empty title={chosen ? `Nothing ${chosen}` : "Nothing reported"}>
          A near miss is worth reporting too: the ladder that nearly slipped is how the next one does not.
        </Empty>
      ) : (
        <Table label="Incident reports" head={<><Th>When</Th><Th>What</Th><Th>Who</Th><Th>State</Th></>}>
          {incidents.map((incident) => (
            <tr key={incident.id}>
              <Td className="whitespace-nowrap">{formatIn(incident.occurredAt, zone)}</Td>
              <Td>
                <a href={`/compliance/incidents/${incident.id}`} className="font-medium text-blue-600 underline underline-offset-4">
                  {rules.INCIDENT_KIND_WORDS[incident.kind].split(":")[0]}
                </a>
                <span className="block max-w-md truncate text-xs text-ink-500">{incident.description}</span>
              </Td>
              <Td className="text-sm text-ink-700">
                {incident.people.map((p) => `${p.name} (${rules.PERSON_ROLE_WORDS[p.role].toLowerCase()})`).join(", ") || "Nobody named"}
              </Td>
              <Td>{incident.status === "open" ? <Chip tone="warning">Open</Chip> : <Chip tone="neutral">Closed</Chip>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
