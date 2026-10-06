import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { laborSettings } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { Fact, Facts } from "@/components/Detail";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay, formatIn, todayIn } from "@/lib/dates";
import { act } from "./actions";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ON_CALL = {
  separate_rate_not_hours_worked: "Paid separately, not counted as hours worked",
  hours_worked_at_base: "Counted as hours worked, at the normal rate",
} as const;
const AUTHORITY: Record<string, string> = {
  employee_default: "Our own rate",
  collective_agreement: "Union agreement",
  wage_determination: "Prevailing wage",
  contract: "Set by a contract",
  manual_override: "One off",
};
const hours = (minutes: number | null) => (minutes === null ? "None" : `${minutes / 60} hours`);

/**
 * WHAT PEOPLE ARE PAID, DECLARED
 *
 * The overtime policy and the wage scales had services, core checks and,
 * now, routes, and no screen: the timesheet refused to run without a policy
 * and told the owner to set one somewhere that did not exist, and every punch
 * by somebody with no scale cost nothing.
 *
 * NOTHING HERE IS EDITED IN PLACE. A new policy replaces the old one and a
 * changed rate closes the old scale the day before the new one starts,
 * because last quarter's job costing was computed from what was declared
 * then, and editing it would move numbers somebody already reported.
 *
 * `timesheet:read` to look, `payroll:configure` to declare: stating what
 * people are owed is a different act from running the export.
 */
export default async function PayRulesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const zone = user.organizationTimezone;

  if (!can(user.actor, "timesheet:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Pay rules" />
        <Empty title="Not shown to your role">
          Pay rules need the permission that reads timesheets, and changing them needs a second one.
        </Empty>
      </div>
    );
  }

  const [policies, scales, people] = await Promise.all([
    laborSettings.policies(ctx),
    laborSettings.scales(ctx, {}),
    laborSettings.crewRates(ctx),
  ]);
  const configures = can(user.actor, "payroll:configure");
  const current = policies.find((p) => p.active) ?? null;
  const classifications = [...new Set(scales.map((s) => s.classification))].sort();
  const today = todayIn(zone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Pay rules" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        When overtime starts, and what each kind of work is paid. Nothing here is edited in place:
        a new rule replaces the old one from a date, so time already worked keeps the rate and the
        rule it was worked under.
      </p>

      <section className="mt-8" aria-labelledby="policy-heading">
        <h2 id="policy-heading" className="text-base font-semibold">Overtime</h2>
        {current ? (
          <>
            <Facts>
              <Fact label="Rule">{current.label}</Fact>
              <Fact label="Week starts">{WEEKDAYS[current.weekStartsOn] ?? current.weekStartsOn}</Fact>
              <Fact label="Overtime after, a week">{hours(current.weeklyThresholdMinutes)}</Fact>
              <Fact label="Overtime after, a day">{hours(current.dailyThresholdMinutes)}</Fact>
              <Fact label="Overtime pays">{current.overtimeMultiplier} times</Fact>
              <Fact label="Double time pays">{current.doubleTimeMultiplier} times</Fact>
              <Fact label="On call">{ON_CALL[current.onCallTreatment as keyof typeof ON_CALL] ?? current.onCallTreatment}</Fact>
              <Fact label="Punches rounded">{current.rounding ?? "Not rounded"}</Fact>
            </Facts>
            {current.note ? <p className="mt-3 max-w-2xl text-sm text-ink-700">{current.note}</p> : null}
          </>
        ) : (
          <Empty title="No overtime rule yet">
            Timesheets cannot be worked out without one, because every default is a position on what
            somebody is owed. Declare yours below.
          </Empty>
        )}

        {policies.length > 1 ? (
          <Table label="Earlier overtime rules" head={<><Th>Rule</Th><Th>Declared</Th><Th>State</Th></>}>
            {policies.map((policy) => (
              <tr key={policy.id}>
                <Td>{policy.label}</Td>
                <Td>{formatIn(policy.declaredOn, zone)}</Td>
                <Td><Chip tone={policy.active ? "success" : "neutral"}>{policy.active ? "In use" : "Replaced"}</Chip></Td>
              </tr>
            ))}
          </Table>
        ) : null}

        {configures ? (
          <details className="mt-4 rounded-md border border-steel-200 p-4" open={!current}>
            <summary className="cursor-pointer text-sm font-medium">
              {current ? "Replace the overtime rule" : "Declare the overtime rule"}
            </summary>
            <ActionForm action={act} submit="Declare overtime rule" hidden={{ op: "policy" }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Name" name="label" required placeholder="Federal, forty hours" />
                <Select label="The week starts on" name="weekStartsOn" defaultValue={String(current?.weekStartsOn ?? 0)}
                        options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))} />
                <TextField label="Overtime after this many hours a week" name="weeklyHours" type="number" step="0.25" min={0}
                           defaultValue={current?.weeklyThresholdMinutes != null ? String(current.weeklyThresholdMinutes / 60) : "40"} />
                <TextField label="Overtime after this many hours a day" name="dailyHours" type="number" step="0.25" min={0}
                           placeholder="Leave empty for none" />
                <TextField label="Double time after this many hours a week" name="weeklyDoubleHours" type="number" step="0.25" min={0}
                           placeholder="Leave empty for none" />
                <TextField label="Double time after this many hours a day" name="dailyDoubleHours" type="number" step="0.25" min={0}
                           placeholder="Leave empty for none" />
                <TextField label="Overtime pays this many times the rate" name="overtimeMultiplier" defaultValue="1.5" required />
                <TextField label="Double time pays this many times the rate" name="doubleTimeMultiplier" defaultValue="2" required />
                <Select label="Time on call" name="onCallTreatment" required
                        options={[
                          { value: "", label: "Choose one" },
                          ...Object.entries(ON_CALL).map(([value, label]) => ({ value, label })),
                        ]} />
                <div className="grid grid-cols-2 gap-3">
                  <TextField label="Round punches to (minutes)" name="roundingMinutes" type="number" min={1} max={60}
                             placeholder="Not rounded" />
                  <Select label="Rounding" name="roundingMode"
                          options={[
                            { value: "", label: "None" }, { value: "nearest", label: "Nearest" },
                            { value: "up", label: "Up" }, { value: "down", label: "Down" },
                          ]} />
                </div>
              </div>
              <TextArea label="Why this is the right rule" name="note" required
                        placeholder="Forty hours a week at time and a half. Texas has no daily rule." />
            </ActionForm>
          </details>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="scales-heading">
        <h2 id="scales-heading" className="text-base font-semibold">Wage scales</h2>
        {scales.length === 0 ? (
          <Empty title="No wage scales yet">
            Until a classification has a scale, time worked under it costs nothing, and a job with
            no labour cost on it reads as a very profitable job.
          </Empty>
        ) : (
          <Table label="Wage scales"
                 head={<><Th>Classification</Th><Th className="text-right">Rate</Th><Th className="text-right">Fringe</Th><Th>Set by</Th><Th>From</Th><Th>Until</Th><Th>{""}</Th></>}>
            {scales.map((scale) => (
              <tr key={scale.id}>
                <Td className="font-medium">{scale.classification}</Td>
                <Td className="text-right"><Money value={scale.baseRate} /></Td>
                <Td className="text-right">{scale.fringeRate ? <Money value={scale.fringeRate} /> : ""}</Td>
                <Td>
                  {AUTHORITY[scale.authority] ?? scale.authority}
                  {scale.externalReference ? <span className="block text-xs text-ink-500">{scale.externalReference}</span> : null}
                </Td>
                <Td className="whitespace-nowrap">{scale.effectiveFrom ? formatDay(scale.effectiveFrom, zone) : "Always"}</Td>
                <Td className="whitespace-nowrap">
                  {scale.effectiveTo ? formatDay(scale.effectiveTo, zone) : "Still in effect"}
                  {!scale.active ? <span className="block"><Chip>Retired</Chip></span> : null}
                </Td>
                <Td>
                  {configures && scale.active ? (
                    <details>
                      <summary className="cursor-pointer text-sm text-blue-600">Change or retire</summary>
                      <ActionForm action={act} submit="Change rate" className="mt-3 space-y-3"
                                  hidden={{ op: "revise", id: scale.id }}>
                        <TextField label="New hourly rate" name="baseRate" required inputMode="decimal" />
                        <TextField label="New fringe (optional)" name="fringeRate" inputMode="decimal" />
                        <TextField label="From" name="effectiveFrom" type="date" required />
                      </ActionForm>
                      <ActionForm action={act} submit="Retire" tone="danger" className="mt-4 space-y-3"
                                  hidden={{ op: "retire", id: scale.id }}>
                        <TextField label="Last day it applies" name="effectiveTo" type="date" required defaultValue={today} />
                      </ActionForm>
                    </details>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {configures ? (
          <details className="mt-4 rounded-md border border-steel-200 p-4" open={scales.length === 0}>
            <summary className="cursor-pointer text-sm font-medium">Load a wage scale</summary>
            <ActionForm action={act} submit="Load scale" hidden={{ op: "load" }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Classification" name="classification" required placeholder="Journeyman Electrician" />
                <TextField label="Hourly rate" name="baseRate" required inputMode="decimal" placeholder="42.00" />
                <TextField label="Fringe per hour (optional)" name="fringeRate" inputMode="decimal" />
                <Select label="Set by" name="authority"
                        options={Object.entries(AUTHORITY).map(([value, label]) => ({ value, label }))} />
                <TextField label="Reference (needed for a union agreement or a prevailing wage)" name="externalReference" />
                <TextField label="Where it applies (optional)" name="jurisdiction" />
                <TextField label="From (optional)" name="effectiveFrom" type="date" />
              </div>
            </ActionForm>
          </details>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="people-heading">
        <h2 id="people-heading" className="text-base font-semibold">Who is paid at what</h2>
        {people.length === 0 ? (
          <Empty title="Nobody on the crew yet" />
        ) : (
          <Table label="Who is paid at what"
                 head={<><Th>Person</Th><Th>Classification</Th><Th className="text-right">Rate today</Th><Th>{""}</Th></>}>
            {people.map((person) => (
              <tr key={person.id}>
                <Td className="font-medium">{person.displayName}</Td>
                <Td>
                  {person.classification ?? "None"}
                  {person.unpricedBecause ? <span className="block text-xs text-red-600">{person.unpricedBecause}</span> : null}
                </Td>
                <Td className="text-right">{person.baseRate ? <Money value={person.baseRate} /> : ""}</Td>
                <Td>
                  {configures && classifications.length > 0 ? (
                    <ActionForm action={act} submit="Set" tone="quiet" className="flex items-end gap-2"
                                hidden={{ op: "classify", technicianId: person.id }}>
                      <Select label={`Classification for ${person.displayName}`} name="classification"
                              defaultValue={person.classification ?? ""} className="block w-56"
                              options={[{ value: "", label: "None" }, ...classifications.map((c) => ({ value: c, label: c }))]} />
                    </ActionForm>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
