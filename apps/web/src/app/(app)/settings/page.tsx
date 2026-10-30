import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  inTenant, roles as roleService, branding as brandingService,
  telephony as telephonyService, phoneNumbers as numberService, acquisition,
  people as peopleService, setup as setupService, documents, visitCancellations, jobHolds, noticeUpkeep, noticeDefaults, taskRules,
} from "@opentradesos/api/services";
import { can, ROLE_PRESETS } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq, isNull } from "drizzle-orm";
import { Chip, Phone } from "@opentradesos/ui";
import { PHONE_PURPOSE, label } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Branding } from "./Branding";
import { CompanyDetails } from "./CompanyDetails";
import { Timezone } from "./Timezone";
import { Recording } from "./Recording";
import { Numbers } from "./Numbers";
import { Buy } from "./Buy";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { saveNoticeDefaults, setCancelNotice, setHoldNudge, setNoticeKeeping } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS
 *
 * The three things built most recently had nowhere to be seen: the phone
 * numbers a company has connected, the roles they have defined, and the
 * workflows that are running. A capability an owner cannot see the state of
 * is one they will not trust, and the first question about an automation is
 * always "is it on".
 *
 * Read only for now, and it says so rather than rendering controls that do
 * nothing. A disabled button with no explanation is worse than an absent one.
 */
export default async function SettingsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  const writes = can(user.actor, "settings:write");
  const brand = await brandingService.current(ctx).catch(() => null);
  /** Whether the PDFs can print the logo kept now; asked only when there is one. */
  const logoPrints = brand?.hasLogo ? await documents.logoPrints(ctx).catch(() => true) : true;
  const details = writes ? await setupService.details(ctx) : null;

  /**
   * Through the service rather than the raw table, so the row knows which
   * number texts come from. That is a consequence of purpose, registration
   * and age, and the page was reading three columns and showing none of it.
   */
  const numbers = await numberService.list(ctx, {});
  /** The channels and their tracking campaigns, for what a tracking number is credited to. */
  const credits = writes ? await acquisition.channelOptions(ctx) : [];

  const data = await inTenant(ctx, async (tx) => ({
    numbers: await tx.select().from(schema.phoneNumber)
      .where(isNull(schema.phoneNumber.releasedAt)),
    connections: await tx.select().from(schema.integrationConnection)
      .where(eq(schema.integrationConnection.capability, "messaging")),
    workflows: await tx.select().from(schema.workflow)
      .where(isNull(schema.workflow.deletedAt)),
    /** The live branches a number can answer for, whose hours then route its calls. */
    branches: await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
      .from(schema.businessUnit).where(eq(schema.businessUnit.active, true)),
    organization: (await tx.select({ timezone: schema.organization.timezone })
      .from(schema.organization)
      .where(eq(schema.organization.id, user.actor.organizationId)).limit(1))[0],
  }));

  /**
   * Through the people service, not a join to the user table. That table's
   * row level security returns the caller's own row and nothing else, so the
   * join this page used to make showed an owner a company of one.
   */
  const members = can(user.actor, "user:read") ? await peopleService.members(ctx) : null;

  const customRoles = can(user.actor, "role:write") ? await roleService.list(ctx) : [];
  const recordingPolicies = writes ? await telephonyService.listPolicies(ctx) : [];
  const cancelNotice = writes ? await visitCancellations.notice(ctx) : null;
  const holdNudge = writes ? await jobHolds.nudgeSetting(ctx) : null;
  /** Who the nudge can be given to: the people who work here, named by somebody who may open tasks. */
  const holdPeople = holdNudge && can(user.actor, "task:read") ? await taskRules.assignable(ctx) : [];
  const keeping = writes ? await noticeUpkeep.keeping(ctx) : null;
  const noticeStart = writes ? await noticeDefaults.defaults(ctx) : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Settings" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {user.organizationName}. The company's details, the look, the time zone, call recording
        and phone numbers are changed here. People are invited and given roles on{" "}
        <a href="/settings/team" className="underline underline-offset-4">Team</a>, and the setup list
        is still at <a href="/setup" className="underline underline-offset-4">Setup</a>, with what is
        done ticked off.
      </p>

      {/*
        First, because it is the only thing on this screen somebody can
        actually change, and a page that opens on four read only tables
        teaches people it is not worth visiting.
      */}
      {details && <CompanyDetails details={details} />}

      {writes && brand && (
        <Branding
          color={brand.color} on={brand.on} text={brand.text}
          hasLogo={brand.hasLogo} hasFavicon={brand.hasFavicon} version={brand.version}
          logoPrints={logoPrints}
        />
      )}

      {writes && data.organization && <Timezone current={data.organization.timezone} />}

      {/*
        The company's cancellation policy, which decides which cancellations
        are late on the cleaning scorecard. Beside the time zone because it
        is the same kind of rule: said once, applied to every visit after.
      */}
      {cancelNotice && (
        <section aria-label="Late cancellations" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="font-medium text-ink-900">Late cancellations</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            How many hours before a visit a customer has to cancel. Cancelling with less notice, or turning the team
            away at the door, counts as a late cancellation on the scorecard. Visits you call off yourself never do.
            Changing this does not change visits already cancelled.
          </p>
          <ActionForm action={setCancelNotice} submit="Save" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Hours of notice" name="hours" type="number" min={0} max={720} step={1}
                       defaultValue={String(cancelNotice.hours)} className="block w-40" />
          </ActionForm>
        </section>
      )}

      {/*
        How long a job may wait on hold before the office is told. Off until
        the company picks a number, because what is a long wait differs by
        trade.
      */}
      {holdNudge && (
        <section aria-label="Jobs on hold" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="font-medium text-ink-900">Jobs on hold</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Say how many days a job can wait on hold before the office gets a task about it. The task names the job,
            why it is on hold and for how long, and closes itself when the job comes off hold. Leave the first box
            empty and nobody is nudged. "Days to do it by" gives the task a due date, so it counts as late and the
            rules under Tasks can act on it. "Remind again" raises a new task that many days later if the job is still
            on hold and the last task has been closed. Leave either box empty to turn it off.
          </p>
          <ActionForm action={setHoldNudge} submit="Save" className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <TextField label="Days on hold before a nudge" name="days" type="number" min={1} max={90} step={1}
                         defaultValue={holdNudge.days === null ? "" : String(holdNudge.days)} className="block w-40" />
              <TextField label="Days to do it by" name="dueDays" type="number" min={0} max={30} step={1}
                         defaultValue={holdNudge.dueDays === null ? "" : String(holdNudge.dueDays)} className="block w-40" />
              <TextField label="Remind again every (days)" name="repeatDays" type="number" min={1} max={90} step={1}
                         defaultValue={holdNudge.repeatDays === null ? "" : String(holdNudge.repeatDays)} className="block w-48" />
            </div>
            <Select label="Who gets the task" name="assignTo" className="block max-w-md"
                    defaultValue={holdNudge.assignTo === "person" && holdNudge.assigneeUserId ? `person:${holdNudge.assigneeUserId}` : holdNudge.assignTo}
                    options={[
                      { value: "nobody", label: "Nobody in particular (the office queue)" },
                      { value: "placed_by", label: "Whoever put the job on hold" },
                      ...holdPeople.map((p) => ({ value: `person:${p.userId}`, label: p.name })),
                      ...(holdNudge.assignTo === "person" && holdNudge.assigneeUserId && !holdPeople.some((p) => p.userId === holdNudge.assigneeUserId)
                        ? [{ value: `person:${holdNudge.assigneeUserId}`, label: holdNudge.assigneeName ?? "Somebody who has left" }] : []),
                    ]} />
          </ActionForm>
        </section>
      )}

      {/*
        How long the bell keeps what people have read. Kept for good until
        the company picks a number, which is what has always happened.
      */}
      {keeping && (
        <section aria-label="Read notices" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="font-medium text-ink-900">Read notices</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            How many days to keep a notice after the person has read it. After that it is removed from their bell for
            good. Unread notices are never removed. A licence or toolbox talk notice stays a little longer, so nobody is
            told about the same thing twice. Leave the box empty to keep every notice.
          </p>
          <ActionForm action={setNoticeKeeping} submit="Save" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Days to keep read notices" name="days" type="number" min={7} max={3650} step={1}
                       defaultValue={keeping.keepDays === null ? "" : String(keeping.keepDays)} className="block w-48" />
          </ActionForm>
        </section>
      )}

      {/*
        What a person added from now on starts with on their bell, their phone
        and (where a kind is emailed) their email. Copied onto each new person;
        nobody already here is changed, and texts are never started for anyone.
      */}
      {noticeStart && (
        <section id="notice-defaults" aria-label="What new people are told" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="font-medium text-ink-900">What new people are told</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Where each kind of notice reaches a person you add from now on. They can change their own on their page.
            People already here keep what they have. Texts are not here: a person turns those on themselves, with
            their own number.
          </p>
          <ActionForm action={saveNoticeDefaults} submit="Save" className="mt-3 space-y-3">
            <Table head={<><Th>Notice</Th><Th>In the app</Th><Th>Phone app</Th><Th>Email</Th></>}>
              {noticeStart.kinds.map((k) => (
                <tr key={k.kind}>
                  <Td><span className="font-medium">{k.label}</span><span className="block text-xs text-ink-500">{k.description}</span></Td>
                  <Td><input type="checkbox" name={`${k.kind}.inApp`} defaultChecked={k.inApp} aria-label={`${k.label}: in the app`} className="h-4 w-4 rounded border-steel-300" /></Td>
                  <Td><input type="checkbox" name={`${k.kind}.push`} defaultChecked={k.push} aria-label={`${k.label}: on the phone app`} className="h-4 w-4 rounded border-steel-300" /></Td>
                  <Td>
                    {k.email === null
                      ? <span className="text-xs text-ink-500">Not emailed</span>
                      : <input type="checkbox" name={`${k.kind}.email`} defaultChecked={k.email} aria-label={`${k.label}: by email`} className="h-4 w-4 rounded border-steel-300" />}
                  </Td>
                </tr>
              ))}
            </Table>
          </ActionForm>
        </section>
      )}

      {/*
        Below the time zone because both are declarations about the world
        that the product then applies everywhere without asking again.
      */}
      {writes && <Recording policies={recordingPolicies} />}

      <Section
        title="Phone numbers"
        description="A number must be registered before it can send. An unregistered send is not merely rejected by the carrier: it counts against the sender."
      >
        {/*
          Editable now, where it used to be a read only table. The page said
          so at the top, honestly, while the two columns that matter most on
          this table could not be set by anything at all: what a tracking
          number attributes to, and whether a number has been handed back.
        */}
        {writes ? (
          <>
            <Numbers
              numbers={numbers}
              credits={credits}
              branches={data.branches}
            />
            {/*
              Only when a Twilio account is connected, which is where the
              numbers are bought from. Without one, the form above is the way
              to record a number bought somewhere else.
            */}
            {data.connections.some((c) => c.provider === "twilio" && c.status === "connected")
              ? <Buy credits={credits} />
              : (
                <p className="mt-3 text-sm text-ink-700">
                  Connect Twilio under <a href="/settings/integrations" className="underline underline-offset-4">Integrations</a> to
                  buy tracking numbers here and have their calls routed, whispered and recorded by this product.
                </p>
              )}
          </>
        ) : numbers.length === 0 ? (
          <Empty title="No numbers connected">
            Connect a carrier and add a number to send appointment reminders
            and take replies.
          </Empty>
        ) : (
          <Table head={<><Th>Number</Th><Th>Purpose</Th><Th>Label</Th><Th>SMS</Th></>}>
            {numbers.map((number) => (
              <tr key={number.id}>
                <Td><Phone value={number.e164} /></Td>
                <Td className="text-ink-700">{label(PHONE_PURPOSE, number.purpose)}</Td>
                <Td className="text-ink-700">{number.label ?? ""}</Td>
                <Td>
                  <Chip tone={number.smsRegistered ? "success" : "warning"}>
                    {number.smsRegistered ? "Registered" : "Not registered"}
                  </Chip>
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {data.connections.length > 0 ? (
          <p className="mt-3 text-sm text-ink-700">
            Carrier:{" "}
            {data.connections.map((c) => `${c.provider} (${c.status})`).join(", ")}
          </p>
        ) : (
          <p className="mt-3 text-sm text-ink-700">
            No carrier connected, so messages are written and stay queued.
          </p>
        )}
      </Section>

      <Section
        title="Automations"
        description="A workflow reacts to something that happened. It runs with the permissions its version declared, not with yours and not with the owner's."
      >
        {data.workflows.length === 0 ? (
          <Empty title="No workflows yet">
            An automation reacts to an event: a job completed, an invoice paid.
          </Empty>
        ) : (
          <Table head={<><Th>Name</Th><Th>Triggers on</Th><Th>State</Th></>}>
            {data.workflows.map((workflow) => (
              <tr key={workflow.id}>
                <Td className="font-medium">{workflow.name}</Td>
                <Td className="font-mono text-xs text-ink-700">
                  {(workflow.triggerEvents ?? []).join(", ")}
                </Td>
                <Td>
                  <Chip tone={workflow.enabled ? "success" : "neutral"}>
                    {workflow.enabled ? "On" : "Off"}
                  </Chip>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="People"
        description="A custom role replaces the preset rather than adding to it, so a membership shows whichever one is actually deciding."
      >
        {members === null ? (
          <Empty title="Not shown to your role">Seeing who works here needs the View users permission.</Empty>
        ) : (
        <Table head={<><Th>Person</Th><Th>Role</Th><Th>Scope limits</Th></>}>
          {members.map(({ membership, email, name, roleName }) => (
            <tr key={membership.id}>
              <Td>
                <span className="font-medium">{name ?? email}</span>
                {name ? <span className="ml-2 text-ink-500">{email}</span> : null}
              </Td>
              <Td>
                {roleName
                  ? <Chip tone="info">{roleName}</Chip>
                  : <span className="text-ink-700">{ROLE_PRESETS[membership.role]?.label ?? membership.role}</span>}
              </Td>
              <Td className="text-ink-700">
                {/*
                  This column was blank for everybody, forever.
                  `membership.scope_overrides` was written by nothing, so an
                  administrator read a blank column and concluded nobody's
                  access had been narrowed. That was true, and true only
                  because narrowing anybody's access was impossible.
                  Saying so where the blank is beats leaving an empty cell
                  that reads as a fact.
                */}
                {Object.keys(membership.scopeOverrides ?? {}).length === 0
                  ? <span className="text-ink-500">None</span>
                  : Object.entries(membership.scopeOverrides).map(([k, v]) => `${k}: ${v}`).join(", ")}
              </Td>
            </tr>
          ))}
        </Table>
        )}
      </Section>

      {can(user.actor, "role:write") ? (
        <Section
          title="Custom roles"
          description="You can only put permissions in a role that you hold yourself, and only set scopes at least as narrow as your own. Without that rule, being allowed to edit roles would be the same as holding every permission there is."
        >
          {customRoles.length === 0 ? (
            <Empty title="No custom roles">
              The nine presets are starting points. A company with branches
              usually wants a branch manager before long.
            </Empty>
          ) : (
            <Table head={<><Th>Name</Th><Th>Based on</Th><Th>Permissions</Th></>}>
              {customRoles.map((role) => (
                <tr key={role.id}>
                  <Td className="font-medium">{role.name}</Td>
                  <Td className="text-ink-700">{role.basedOn ?? ""}</Td>
                  <Td className="text-ink-700">{role.permissions.length}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title, description, children,
}: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">{description}</p>
      {children}
    </section>
  );
}
