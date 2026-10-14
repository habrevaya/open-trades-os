import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { plugins as pluginService } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { formatDay, todayIn } from "@/lib/dates";
import { SwitchPlugin } from "./SwitchPlugin";

export const dynamic = "force-dynamic";

/**
 * WHAT THE APPLICATIONS CHANGED, AND A SWITCH FOR EACH
 *
 * An application the company let in can add pricing rules, job stages and
 * report types. Turning the application off turns all of it off, which is
 * too big a hammer for "this one discount is wrong". Here each is listed
 * under what it is, with who added it, what it does in a sentence and
 * whether it is in force, and somebody who may connect applications
 * (`integration:write`) turns one off on its own, and back on. The
 * application is not turned off, its other work carries on, and a new
 * version it sends does not switch back on what somebody here stopped.
 *
 * The state is said in words on every row, because "why is this invoice ten
 * per cent less" and "why did this job let me skip the survey" are asked
 * of this page, and the answer may be that a rule has been off since March.
 */
const KINDS = [
  { kind: "pricing_rule", title: "Pricing rules", note: "Change what an estimate or an invoice charges, after a member's price and before tax." },
  { kind: "job_workflow", title: "Job stages", note: "Name the steps a kind of job moves through and what has to be done before it leaves one." },
  { kind: "report_type", title: "Report types", note: "Reports an application added to the report builder." },
] as const;

export default async function AddedPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read") || !can(user.actor, "integration:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="What applications changed" />
        <Empty title="This is not part of your access">
          Seeing what applications added needs the permission that reads integrations. Somebody who
          can change roles can turn it on for you.
        </Empty>
      </div>
    );
  }

  const list = await pluginService.companyList(ctx);
  const writes = can(user.actor, "integration:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <a href="/settings/apps" className="text-sm text-ink-500 hover:underline">Applications</a>
      <div className="mt-2">
        <PageHeader title="What applications changed" />
      </div>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Applications you let in can add their own pricing rules, job stages and reports. You can stop
        any one of them here without turning the application off. A rule you turn off stops changing
        prices from the next estimate or invoice. Stages you turn off stop holding jobs back. A report
        you turn off is not offered, and a report saved on it will not run until you turn it back on.
        Nothing already priced or moved is changed.
      </p>
      {writes ? null : (
        <p className="mt-2 max-w-2xl text-sm text-ink-500">
          Turning one off or on needs the permission that connects applications. You can see them all.
        </p>
      )}

      {list.length === 0 ? (
        <div className="mt-6">
          <Empty title="Nothing added yet">
            No application has added a pricing rule, job stages or a report. When one does, it is listed
            here with a switch.
          </Empty>
        </div>
      ) : (
        KINDS.map(({ kind, title, note }) => {
          const rows = list.filter((plugin) => plugin.kind === kind);
          if (rows.length === 0) return null;
          return (
            <section key={kind} className="mt-8" aria-labelledby={`added-${kind}`}>
              <h2 id={`added-${kind}`} className="text-base font-semibold">{title}</h2>
              <p className="mt-0.5 text-sm text-ink-500">{note}</p>
              <Table
                label={title}
                head={<><Th>Name</Th><Th>From</Th><Th>What it does</Th><Th>State</Th>{writes ? <Th /> : null}</>}
              >
                {rows.map((plugin) => (
                  <tr key={plugin.id}>
                    <Td className="font-medium">
                      {plugin.name}
                      <span className="block text-xs font-normal text-ink-500">Version {plugin.version}</span>
                    </Td>
                    <Td>{plugin.appName}</Td>
                    <Td className="text-ink-700">{plugin.summary}</Td>
                    <Td>
                      {plugin.state === "on" ? <Chip tone="success">On</Chip> : null}
                      {plugin.state === "turned_off" ? <Chip tone="warning">Turned off</Chip> : null}
                      {plugin.state === "app_off" ? <Chip tone="neutral">Off: the application is turned off</Chip> : null}
                      {plugin.state === "removed" ? <Chip tone="neutral">Removed by the application</Chip> : null}
                      {plugin.turnedOff ? (
                        <span className="mt-1 block text-xs text-ink-500">
                          {plugin.turnedOff.by ?? "Somebody"} turned it off on {formatDay(todayIn(user.organizationTimezone, new Date(plugin.turnedOff.at)), user.organizationTimezone)}
                          {plugin.turnedOff.reason ? `: ${plugin.turnedOff.reason}` : ""}
                        </span>
                      ) : null}
                    </Td>
                    {writes ? (
                      <Td>
                        {plugin.state === "on" || plugin.state === "turned_off"
                          ? <SwitchPlugin id={plugin.id} name={plugin.name} on={plugin.state === "on"} />
                          : null}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </Table>
            </section>
          );
        })
      )}
    </div>
  );
}
