import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  inTenant, roles as roleService, branding as brandingService,
  telephony as telephonyService, phoneNumbers as numberService, acquisition,
  people as peopleService,
} from "@opentradesos/api/services";
import { can, ROLE_PRESETS } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { eq, isNull } from "drizzle-orm";
import { Chip, Phone } from "@opentradesos/ui";
import { PHONE_PURPOSE, label } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Branding } from "./Branding";
import { Timezone } from "./Timezone";
import { Recording } from "./Recording";
import { Numbers } from "./Numbers";
import { Buy } from "./Buy";

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

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Settings" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {user.organizationName}. The look, the time zone, call recording and phone numbers are
        changed here. People are invited and given roles on{" "}
        <a href="/settings/team" className="underline underline-offset-4">Team</a>, and the setup list
        is still at <a href="/setup" className="underline underline-offset-4">Setup</a>, with what is
        done ticked off.
      </p>

      {/*
        First, because it is the only thing on this screen somebody can
        actually change, and a page that opens on four read only tables
        teaches people it is not worth visiting.
      */}
      {writes && brand && (
        <Branding
          color={brand.color} on={brand.on} text={brand.text}
          hasLogo={brand.hasLogo} hasFavicon={brand.hasFavicon} version={brand.version}
        />
      )}

      {writes && data.organization && <Timezone current={data.organization.timezone} />}

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
