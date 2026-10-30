import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets, laborSettings, mileageOverrides, payExtras, tipRules } from "@opentradesos/api/services";
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

  const [policies, scales, people, extras, overrides, fleet, ownTipRules] = await Promise.all([
    laborSettings.policies(ctx),
    laborSettings.scales(ctx, {}),
    laborSettings.crewRates(ctx),
    payExtras.get(ctx),
    mileageOverrides.list(ctx),
    /** The picker of vehicles needs the fleet register, which not everybody who reads pay rules may read. */
    can(user.actor, "asset:read") ? assets.listAssets(ctx, { kind: "vehicle" }) : Promise.resolve({ on: "", assets: [] }),
    tipRules.list(ctx),
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
                 head={<><Th>Classification</Th><Th className="text-right">Rate</Th><Th className="text-right">Fringe</Th><Th>Agreement terms</Th><Th>Set by</Th><Th>From</Th><Th>Until</Th><Th>{""}</Th></>}>
            {scales.map((scale) => (
              <tr key={scale.id}>
                <Td className="font-medium">{scale.classification}</Td>
                <Td className="text-right"><Money value={scale.baseRate} /></Td>
                <Td className="text-right">{scale.fringeRate ? <Money value={scale.fringeRate} /> : ""}</Td>
                <Td className="text-sm text-ink-700">
                  {scale.overtimeMultiplier ? <span className="block">Overtime {scale.overtimeMultiplier} times</span> : null}
                  {scale.doubleTimeMultiplier ? <span className="block">Double time {scale.doubleTimeMultiplier} times</span> : null}
                  {scale.apprenticeRatio ? <span className="block">Apprentices {scale.apprenticeRatio}</span> : null}
                </Td>
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
                <TextField label="Overtime pays this many times, if the agreement says" name="overtimeMultiplier"
                           inputMode="decimal" placeholder="1.5" />
                <TextField label="Double time pays this many times, if the agreement says" name="doubleTimeMultiplier"
                           inputMode="decimal" placeholder="2" />
                <TextField label="Apprentices to journeymen, if the agreement says" name="apprenticeRatio"
                           maxLength={50} placeholder="1:3" />
              </div>
              <p className="mt-3 max-w-2xl text-sm text-ink-700">
                The three agreement terms are kept with the scale so they are on file next to the rate.
                They do not change what a week costs: overtime is still worked out from the company&rsquo;s
                overtime rule above, and nothing checks the apprentice ratio against who is on a job.
              </p>
            </ActionForm>
          </details>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="extras-heading">
        <h2 id="extras-heading" className="text-base font-semibold">Tips and days away</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          How a tip a customer leaves is shared between the people on the job, and what a day away from
          home is worth. A change applies from the next tip and the next day recorded: tips already shared
          and days already recorded keep what they were worked out at. The office records the days away on
          Expenses. This is the one rate for a day away where no place below applies.
        </p>
        <Facts>
          <Fact label="Tips are shared">{extras.rules.find((r) => r.rule === extras.tipSplit)?.label ?? null}</Fact>
          <Fact label="A day away is worth">{extras.perDiemRate ? <Money value={extras.perDiemRate} /> : "Not set, so none is paid"}</Fact>
        </Facts>
        {configures ? (
          <ActionForm action={act} submit="Save" hidden={{ op: "extras" }} className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2">
            <Select label="Share a tip" name="tipSplit" defaultValue={extras.tipSplit}
                    options={extras.rules.map((r) => ({ value: r.rule, label: r.label }))} />
            <TextField label="A day away is worth (dollars)" name="perDiemRate" inputMode="decimal"
                       defaultValue={extras.perDiemRate ?? ""} placeholder="75.00" />
            <p className="text-sm text-ink-700 sm:col-span-2">
              By hours means the hours each person was clocked in on the job. By the hours on the visit means
              the visit the tip was for: the one it was taken on, or else the visit finished last. If no hours
              are recorded, or no lead is marked on the job, the tip is shared evenly and the tip says so. A day away is paid with no
              tax taken from it, which is only right while it is within what the tax authority allows for the
              place and the day. That check is yours. Leave the box empty to pay none.
            </p>
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="own-tip-rules-heading">
        <h2 id="own-tip-rules-heading" className="text-base font-semibold">Tips on one job, or for one person</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A job or a person can have a rule of their own. A job&rsquo;s rule comes first. Then a person&rsquo;s,
          when everybody on the job who has one has the same one. If two people on a job have different rules,
          the company&rsquo;s rule above is used and the tip says so. A rule here applies from the next tip: tips
          already shared keep theirs.
        </p>
        {ownTipRules.rules.length === 0 ? (
          <p className="mt-3 text-sm text-ink-700">None yet, so every tip is shared by the company&rsquo;s rule.</p>
        ) : (
          <Table label="Tip rules of their own" head={<><Th>For</Th><Th>Shared</Th><Th>Why</Th><Th>{""}</Th></>}>
            {ownTipRules.rules.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">
                  {r.kind === "job" ? `Job ${r.jobNumber}${r.jobSummary ? `, ${r.jobSummary}` : ""}` : r.technicianName}
                </Td>
                <Td className="text-ink-700">{r.ruleLabel}</Td>
                <Td className="text-ink-700">{r.note ?? ""}</Td>
                <Td>
                  {configures ? (
                    <ActionForm action={act} submit="Take off" tone="quiet" hidden={{ op: "tipRuleRemove", id: r.id }} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {configures ? (
          <ActionForm action={act} submit="Save rule" hidden={{ op: "tipRule" }} className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2">
            <Select label="For this person" name="technicianId"
                    options={[{ value: "", label: "Nobody, a job instead" }, ...people.map((p) => ({ value: p.id, label: p.displayName }))]} />
            <TextField label="Or this job number" name="jobNumber" inputMode="numeric" placeholder="1042" />
            <Select label="Share their tips" name="rule" defaultValue="hours"
                    options={extras.rules.map((r) => ({ value: r.rule, label: r.label }))} />
            <TextField label="Why (optional)" name="note" />
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="places-heading">
        <h2 id="places-heading" className="text-base font-semibold">Days away by place</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A day away can be worth more in some places than at home. Add a place with what a day there is worth
          from a date, and the office picks it when they record the days. If the job&rsquo;s address is in a city
          you list here, that place is picked for them. A place with no city is only ever picked by hand, and a
          city you have not listed is never guessed at: they are asked to choose. A day keeps the place and the
          rate it was worked out at, so nothing here changes days already recorded. A day away is paid with no
          tax taken from it, which is only right within what the tax authority allows for that place and day.
          That check is yours. It is not posted to the books.
        </p>
        {extras.perDiemPlaces.length === 0 ? (
          <p className="mt-3 text-sm text-ink-700">No places yet, so every day away is worth the one rate above.</p>
        ) : (
          <Table label="Places" head={<><Th>Place</Th><Th>Where</Th><Th className="text-right">A day today</Th><Th>Rates</Th><Th>{""}</Th></>}>
            {extras.perDiemPlaces.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">
                  {p.name}
                  {p.retired ? <span className="block"><Chip>No longer used</Chip></span> : null}
                </Td>
                <Td className="text-ink-700">{[p.city, p.state].filter(Boolean).join(", ") || "Chosen by hand"}</Td>
                <Td className="text-right tabular-nums">{p.rateToday ? <Money value={p.rateToday} /> : "None yet"}</Td>
                <Td>
                  <ul className="space-y-1 text-sm">
                    {[...p.rates].reverse().map((rate) => (
                      <li key={rate.from} className="flex flex-wrap items-center gap-2">
                        <span><Money value={rate.perDay} /> from {formatDay(rate.from, zone)}</span>
                        {configures && !p.retired ? (
                          <ActionForm action={act} submit={`Take off ${p.name}'s rate from ${formatDay(rate.from, zone)}`} tone="quiet"
                                      hidden={{ op: "placeRateRemove", id: p.id, from: rate.from }} />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td>
                  {configures && !p.retired ? (
                    <details>
                      <summary className="cursor-pointer text-sm text-blue-600">Change or stop using</summary>
                      <ActionForm action={act} submit={`Add a rate for ${p.name}`} className="mt-3 space-y-3"
                                  hidden={{ op: "placeRateAdd", id: p.id }}>
                        <TextField label={`New day rate for ${p.name} (dollars)`} name="perDay" inputMode="decimal" required />
                        <TextField label={`Starting on, for ${p.name}`} name="from" type="date" required defaultValue={today} />
                      </ActionForm>
                      <ActionForm action={act} submit={`Stop using ${p.name}`} tone="danger" className="mt-4"
                                  hidden={{ op: "placeRetire", id: p.id }} />
                    </details>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {configures ? (
          <details className="mt-4 rounded-md border border-steel-200 p-4" open>
            {/* Always open, so the answer to "Add the place" is on the screen when it comes back. */}
            <summary className="cursor-pointer text-sm font-medium">Add a place</summary>
            <ActionForm action={act} submit="Add the place" hidden={{ op: "placeAdd" }}>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Name of the place" name="name" required maxLength={80} placeholder="Austin" />
                <TextField label="A day there is worth (dollars)" name="perDay" required inputMode="decimal" placeholder="85.00" />
                <TextField label="City, so jobs there pick it (optional)" name="city" maxLength={80} placeholder="Austin" />
                <TextField label="State, two letters (optional)" name="state" maxLength={2} placeholder="TX" />
                <TextField label="Worth that from" name="from" type="date" required defaultValue={today} />
              </div>
            </ActionForm>
          </details>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="mileage-heading">
        <h2 id="mileage-heading" className="text-base font-semibold">Mileage</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          What the company pays for one mile in a person&apos;s own vehicle. A claim in miles is worked out at the
          rate that started on or before the day they drove, to the cent, and keeps that rate: adding or taking
          off a line below never changes a claim already made. It is paid back with their pay like any other
          expense, with no tax taken from it, which is only right while the rate is within what the tax
          authority allows. That check is yours. It is not posted to the books.
        </p>
        <Facts>
          <Fact label="A mile is worth today">
            {extras.mileageRateToday ? `$${extras.mileageRateToday}` : "No rate has started, so nobody can claim miles"}
          </Fact>
        </Facts>
        {extras.mileageRates.length > 0 ? (
          <Table label="Mileage rates" head={<><Th>From</Th><Th className="text-right">A mile</Th><Th>{""}</Th></>}>
            {[...extras.mileageRates].reverse().map((rate) => (
              <tr key={rate.from}>
                <Td className="whitespace-nowrap">{formatDay(rate.from, zone)}</Td>
                <Td className="text-right tabular-nums">${rate.perMile}</Td>
                <Td>
                  {configures ? (
                    <ActionForm action={act} submit={`Take off the rate from ${formatDay(rate.from, zone)}`} tone="danger"
                                hidden={{ op: "mileageRemove", from: rate.from }} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        ) : null}
        {configures ? (
          <ActionForm action={act} submit="Add the rate" hidden={{ op: "mileageAdd" }} className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2">
            <TextField label="Starting on" name="from" type="date" required defaultValue={today} />
            <TextField label="Dollars for one mile" name="perMile" inputMode="decimal" required placeholder="0.725" />
          </ActionForm>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="mileage-own-heading">
        <h2 id="mileage-own-heading" className="text-base font-semibold">A mile for one person or one vehicle</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Leave this empty and everybody is paid the company rate above. A line here is for one person or one
          vehicle, from a day. A claim in miles uses the vehicle&apos;s line first, if the person names that vehicle,
          then the person&apos;s line, then the company rate, each as it stood on the day they drove. The claim keeps
          the rate and says whose it was. Adding or taking off a line never changes a claim already made. As with
          the company rate, keeping it within what the tax authority allows without tax is yours to check.
        </p>
        {overrides.lines.length > 0 ? (
          <Table label="Mileage rates for one person or vehicle"
                 head={<><Th>For</Th><Th>From</Th><Th className="text-right">A mile</Th><Th>{""}</Th></>}>
            {overrides.lines.map((line) => (
              <tr key={line.id}>
                <Td className="font-medium">
                  {line.subjectName}
                  <span className="block text-xs font-normal text-ink-500">{line.kind === "person" ? "Person" : "Vehicle"}</span>
                </Td>
                <Td className="whitespace-nowrap">
                  {formatDay(line.from, zone)}
                  {line.inForceToday ? <Chip tone="success" className="ml-2">In use today</Chip> : null}
                </Td>
                <Td className="text-right tabular-nums">${line.perMile}</Td>
                <Td>
                  {configures ? (
                    <ActionForm action={act} submit={`Take off the rate for ${line.subjectName} from ${formatDay(line.from, zone)}`} tone="danger"
                                hidden={{ op: "mileageOverrideRemove", id: line.id }} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        ) : null}
        {configures && people.length > 0 ? (
          <ActionForm action={act} submit="Add the rate for this person" hidden={{ op: "mileageOverrideAdd" }}
                      className="mt-4 grid max-w-xl gap-3 sm:grid-cols-3">
            <Select label="Pick the person" name="technicianId" required
                    options={people.map((p) => ({ value: p.id, label: p.displayName }))} />
            <TextField label="Person's rate starts on" name="from" type="date" required defaultValue={today} />
            <TextField label="Dollars for one mile, for this person" name="perMile" inputMode="decimal" required placeholder="0.725" />
          </ActionForm>
        ) : null}
        {configures && fleet.assets.length > 0 ? (
          <ActionForm action={act} submit="Add the rate for this vehicle" hidden={{ op: "mileageOverrideAdd" }}
                      className="mt-4 grid max-w-xl gap-3 sm:grid-cols-3">
            <Select label="Pick the vehicle" name="assetId" required
                    options={fleet.assets.map((v) => ({ value: v.id, label: v.label }))} />
            <TextField label="Vehicle's rate starts on" name="from" type="date" required defaultValue={today} />
            <TextField label="Dollars for one mile, for this vehicle" name="perMile" inputMode="decimal" required placeholder="0.500" />
          </ActionForm>
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
