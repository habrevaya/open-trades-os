import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taskRules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField, Select } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { TASK_PRIORITY } from "@/lib/labels";
import { addRule, setRuleActive, setManager } from "../rule-actions";

export const dynamic = "force-dynamic";

/**
 * WHAT HAPPENS WHEN A TASK STAYS LATE
 *
 * A late task was red on a screen and told nobody. A rule says how late is
 * too late, who hears about it (the person's manager, everybody in a role, or
 * somebody named) and who takes it over. The worker applies each rule to each
 * task once; the notice is a task in their queue, linked to the late one, and
 * an email when the company sends email.
 *
 * "The manager" needs somebody to be the manager, so who answers to whom is
 * on this page too. With nobody recorded, the owners are told and the task's
 * page says why.
 */
const ROLES = [
  { value: "owner", label: "Owners" }, { value: "admin", label: "Administrators" },
  { value: "office_manager", label: "Office managers" }, { value: "dispatcher", label: "Dispatchers" },
  { value: "csr", label: "Customer service" }, { value: "technician", label: "Technicians" },
  { value: "crew_lead", label: "Crew leads" }, { value: "accountant", label: "Accountants" },
];

export default async function EscalationPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const rules = await taskRules.listRules(ctx);
  const writes = can(user.actor, "task:write");
  const people = await taskRules.assignable(ctx);
  const lines = can(user.actor, "user:read") ? await taskRules.reportingLines(ctx) : null;
  const editsPeople = can(user.actor, "user:write");
  const personOptions = people.map((p) => ({ value: p.userId, label: p.name }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/tasks">Tasks</Crumb>
      <div className="mt-1"><PageHeader title="Escalation" count={rules.length} /></div>

      {rules.length === 0 ? (
        <Empty title="No rules yet">Without one, a late task stays late and nobody is told.</Empty>
      ) : (
        <Table label="Escalation rules" head={<><Th>Rule</Th><Th>What it does</Th><Th className="text-right">Times</Th><Th /></>}>
          {rules.map((r) => (
            <tr key={r.id}>
              <Td>
                <span className="font-medium">{r.name}</span>
                {!r.active ? <> <Chip tone="neutral">Off</Chip></> : null}
              </Td>
              <Td className="text-ink-700">{r.summary}</Td>
              <Td className="text-right tabular-nums">{r.fired}</Td>
              <Td>
                {writes ? (
                  <ActionForm action={setRuleActive} submit={r.active ? "Turn off" : "Turn on"} tone="quiet"
                              hidden={{ id: r.id, active: r.active ? "0" : "1" }} className="flex items-center gap-2" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes && (
        <section aria-label="Add a rule" className="mt-10">
          <h2 className="text-base font-semibold">Add a rule</h2>
          <ActionForm action={addRule} submit="Add rule" className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Name" name="name" required maxLength={120} placeholder="Late call backs" />
              <TextField label="Hours late" name="afterHours" type="number" min={1} max={672} required defaultValue="24" />
              <Select label="Only tasks at least" name="minimumPriority" options={[
                { value: "", label: "Any priority" },
                ...Object.entries(TASK_PRIORITY).filter(([v]) => v !== "low").map(([value, l]) => ({ value, label: l })),
              ]} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Tell" name="target" options={[
                { value: "manager", label: "The person's manager" },
                { value: "role", label: "Everybody in a role" },
                { value: "person", label: "A named person" },
              ]} />
              <Select label="Role (if a role)" name="targetRole" defaultValue="office_manager" options={ROLES} />
              <Select label="Person (if a named person)" name="targetUserId" options={[{ value: "", label: "Choose" }, ...personOptions]} />
            </div>
            <Select label="And hand the task to" name="reassignToUserId"
                    options={[{ value: "", label: "Nobody, leave it where it is" }, ...personOptions]} />
          </ActionForm>
        </section>
      )}

      {lines && (
        <section aria-label="Who answers to whom" className="mt-10">
          <h2 className="text-base font-semibold">Who answers to whom</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-700">
            Read by the rules that tell a person&rsquo;s manager, and by nothing else.
          </p>
          <Table label="Managers" head={<><Th>Person</Th><Th>Answers to</Th></>}>
            {lines.map((line) => (
              <tr key={line.userId}>
                <Td>{line.name}</Td>
                <Td>
                  {editsPeople ? (
                    <ActionForm action={setManager} submit="Save" tone="quiet" hidden={{ userId: line.userId }}
                                className="flex flex-wrap items-center gap-2">
                      <select name="reportsToUserId" defaultValue={line.reportsToUserId ?? ""} aria-label={`Manager of ${line.name}`}
                              className="h-9 w-56 rounded border border-steel-300 bg-canvas px-3 text-sm">
                        <option value="">Nobody recorded</option>
                        {people.filter((p) => p.userId !== line.userId).map((p) => (
                          <option key={p.userId} value={p.userId}>{p.name}</option>
                        ))}
                      </select>
                    </ActionForm>
                  ) : (line.reportsToName ?? "Nobody recorded")}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </div>
  );
}
