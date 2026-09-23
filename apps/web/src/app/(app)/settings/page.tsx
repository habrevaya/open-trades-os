import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inTenant, roles as roleService } from "@opentradesos/api/services";
import { can, ROLE_PRESETS } from "@opentradesos/core";
import { schema } from "@opentradesos/db";
import { and, eq, isNull } from "drizzle-orm";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

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

  const data = await inTenant(ctx, async (tx) => ({
    numbers: await tx.select().from(schema.phoneNumber)
      .where(isNull(schema.phoneNumber.releasedAt)),
    connections: await tx.select().from(schema.integrationConnection)
      .where(eq(schema.integrationConnection.capability, "messaging")),
    workflows: await tx.select().from(schema.workflow)
      .where(isNull(schema.workflow.deletedAt)),
    members: await tx.select({
      membership: schema.membership,
      email: schema.user.email,
      name: schema.user.name,
      roleName: schema.role.name,
    })
      .from(schema.membership)
      .innerJoin(schema.user, eq(schema.user.id, schema.membership.userId))
      .leftJoin(schema.role, and(
        eq(schema.role.id, schema.membership.roleId),
        isNull(schema.role.deletedAt),
      ))
      .where(eq(schema.membership.active, true)),
  }));

  const customRoles = can(user.actor, "role:write") ? await roleService.list(ctx) : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Settings" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {user.organizationName}. Everything here is read only in this build;
        changes go through the API.
      </p>

      <Section
        title="Phone numbers"
        description="A number must be registered before it can send. An unregistered send is not merely rejected by the carrier: it counts against the sender."
      >
        {data.numbers.length === 0 ? (
          <Empty title="No numbers connected">
            Connect a carrier and add a number to send appointment reminders
            and take replies.
          </Empty>
        ) : (
          <Table head={<><Th>Number</Th><Th>Purpose</Th><Th>Label</Th><Th>SMS</Th></>}>
            {data.numbers.map((number) => (
              <tr key={number.id}>
                <Td className="font-mono">{number.e164}</Td>
                <Td className="text-ink-700">{number.purpose}</Td>
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
        <Table head={<><Th>Person</Th><Th>Role</Th><Th>Scope limits</Th></>}>
          {data.members.map(({ membership, email, name, roleName }) => (
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
                {Object.keys(membership.scopeOverrides ?? {}).length === 0
                  ? ""
                  : Object.entries(membership.scopeOverrides).map(([k, v]) => `${k}: ${v}`).join(", ")}
              </Td>
            </tr>
          ))}
        </Table>
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
