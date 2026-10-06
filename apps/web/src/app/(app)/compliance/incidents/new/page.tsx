import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { safety } from "@opentradesos/api/services";
import { can, safety as rules } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { ReportForm } from "./ReportForm";

export const dynamic = "force-dynamic";

/**
 * REPORTING SOMETHING THAT WENT WRONG
 *
 * Short on purpose, and usable from a phone in a driveway: what kind of thing,
 * when, where, what happened in your own words, what you did straight away,
 * who was there, and a photograph. Somebody who was not there can fill in the
 * rest later; the person who was there should not have to.
 */
export default async function ReportIncidentPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "safety:report") && !can(user.actor, "safety:write")) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
        <PageHeader title="Report an incident" />
        <Empty title="Reporting is not part of your access">Tell whoever runs safety, and ask them to turn it on.</Empty>
      </div>
    );
  }
  const people = await safety.people(ctx);
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href="/compliance/incidents">Incidents</Crumb>
      <PageHeader title="Report an incident or near miss" />
      <ReportForm
        kinds={rules.INCIDENT_KINDS.map((kind) => ({ value: kind, label: rules.INCIDENT_KIND_WORDS[kind] }))}
        roles={rules.PERSON_ROLES.map((role) => ({ value: role, label: rules.PERSON_ROLE_WORDS[role] }))}
        people={people}
      />
    </div>
  );
}
