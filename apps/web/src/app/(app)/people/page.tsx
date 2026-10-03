import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE PEOPLE WHO WORK HERE
 *
 * Who they are, when they started, how far through onboarding they are, and
 * whether anybody is on file to ring if they are hurt on a job. That last
 * column is the one a dispatcher needs at three in the afternoon, which is
 * why a person with nobody on file says so in words rather than as a zero.
 */
export default async function PeoplePage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "user:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="People" />
        <Empty title="The staff list is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const people = await peopleRecords.roster({ actor: user.actor, db: getDb() });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="People" count={people.length} />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        The onboarding checklist for each role is on{" "}
        <a href="/people/onboarding" className="underline underline-offset-4">Onboarding</a>. Licences and what
        each person holds are on <a href="/certifications" className="underline underline-offset-4">Certifications</a>.
      </p>
      <Table label="People" head={<><Th>Name</Th><Th>Role</Th><Th>Started</Th><Th>Onboarding</Th><Th>Emergency contact</Th></>}>
        {people.map((p) => (
          <tr key={p.membershipId} className={p.active ? undefined : "text-ink-500"}>
            <Td>
              <a href={`/people/${p.membershipId}`} className="font-medium hover:underline">{p.name ?? p.email}</a>
              {p.active ? null : <span className="ml-2 text-xs">left</span>}
            </Td>
            <Td>{p.roleLabel}</Td>
            <Td className="tabular-nums">{p.startedOn ?? ""}</Td>
            <Td>
              {p.onboarding.total === 0 ? <span className="text-ink-500">Not started</span>
                : p.onboarding.complete ? <Chip tone="success">Done</Chip>
                  : <span>{p.onboarding.requiredDone} of {p.onboarding.required}</span>}
            </Td>
            <Td>{p.emergencyContacts > 0 ? `${p.emergencyContacts} on file` : <span className="text-amber-700">Nobody on file</span>}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
