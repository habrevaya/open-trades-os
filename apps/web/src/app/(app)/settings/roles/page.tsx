import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { roles as roleService } from "@opentradesos/api/services";
import { can, ROLE_IDS, ROLE_PRESETS } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { createRole, giveWholeCompany, removeRole } from "./actions";

export const dynamic = "force-dynamic";

/** What people with a role see, in the words the form offers. */
const SEES: { value: string; label: string; meaning: string }[] = [
  { value: "all", label: "The whole company", meaning: "Every job, customer, invoice and report." },
  { value: "business_unit", label: "Their branch's work", meaning: "The jobs in their branch, and the customers, invoices, estimates, conversations and reports that hang off them, their branch's board, and their branch's people's timesheets and time off." },
  { value: "location", label: "Their shop's work", meaning: "Jobs worked from the shop they are based at (by somebody based there, or a visit sent from there), what hangs off them, and the people based there. Set somebody's shop on Team." },
  { value: "crew", label: "Their crew's work", meaning: "Jobs their crew is sent to, and their own." },
  { value: "own", label: "Only their own work", meaning: "Jobs they are sent to, and what hangs off them." },
];

const seesLabel = (scopes: Record<string, string>) => {
  const values = [...new Set(Object.values(scopes))];
  /**
   * A role of the company's own that names no scope sees its holder's own
   * work, because the narrowest default is the only safe one. This screen
   * used to save "the whole company" that way and label it as such.
   */
  if (values.length === 0) return "Only their own work";
  if (values.length > 1) return "Different for different records";
  return SEES.find((s) => s.value === values[0])?.label ?? values[0]!;
};

/**
 * SETTINGS, ROLES
 *
 * The ten presets are starting points, one of them the branch manager: the
 * office manager's permissions, seeing their branch's work and nothing else.
 * A company that wants another shape makes it here in one form, from a preset
 * and one choice about what its holders see: everything, their branch, their
 * shop, their crew, or only their own.
 *
 * Nobody makes a role bigger than themselves. A role carries only
 * permissions its author holds and sees no further than they do, checked by
 * `canDefineRole` in core, the same rule the API applies; otherwise being
 * allowed to edit roles would be the same as holding every permission there
 * is. Finer grained permission lists are edited through the API.
 */
export default async function RolesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "role:write")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Roles" />
        <Empty title="Making roles is not part of your access">
          Somebody who can change roles can make one for you.
        </Empty>
      </div>
    );
  }

  const custom = await roleService.list(ctx);
  /**
   * Roles that name no scope: saved, before the screen wrote that choice
   * out, as "the whole company", and seeing only their holders' own work
   * since. Or made that way on purpose; nothing can tell which, so the
   * screen asks rather than changing anybody's access.
   */
  const unclear = custom.filter((role) => roleService.namesNoScope(role));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Roles" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A role of your own replaces the preset for whoever holds it. Give one to somebody on{" "}
        <a href="/settings/team" className="underline underline-offset-4">Team</a>. A role limited to a
        branch&apos;s work needs its holder to be in a branch, and one limited to a shop&apos;s work needs their
        shop set, and Team refuses it for somebody who has neither. The Branch manager preset is already a
        branch&apos;s office manager.
      </p>

      {unclear.length > 0 ? (
        <section className="mt-6 max-w-3xl rounded-md border border-amber-700 bg-amber-tint p-4" aria-label="Roles to check">
          <h2 className="text-base font-semibold">
            {unclear.length === 1 ? "One role may need fixing" : `${unclear.length} roles may need fixing`}
          </h2>
          <p className="mt-1 text-sm text-ink-700">
            A role made here before a recent change, with &quot;The whole company&quot; chosen, was saved without it.
            People with it have been seeing only their own work. If that is not what you meant, give it the whole
            company. Their access changes as soon as you do.
          </p>
          <ul className="mt-3 space-y-3">
            {unclear.map((role) => (
              <li key={role.id}>
                <ActionForm action={giveWholeCompany} submit={`Give ${role.name} the whole company`}
                            hidden={{ id: role.id }} className="space-y-2">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-4 w-4" />
                    <span>Yes, people with {role.name} should see every job, customer, invoice and report.</span>
                  </label>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {custom.length === 0 ? (
        <Empty title="No roles of your own yet">
          The Branch manager preset covers most companies with branches. Make one here for any other shape.
        </Empty>
      ) : (
        <Table head={<><Th>Role</Th><Th>Started from</Th><Th>Sees</Th><Th className="text-right">Permissions</Th><Th>{""}</Th></>}>
          {custom.map((role) => (
            <tr key={role.id}>
              <Td>
                <span className="font-medium">{role.name}</span>
                {role.description ? <span className="block text-xs text-ink-500">{role.description}</span> : null}
              </Td>
              <Td className="text-ink-700">{role.basedOn ? ROLE_PRESETS[role.basedOn]?.label ?? role.basedOn : ""}</Td>
              <Td>
                <Chip tone="info">{seesLabel(role.scopes)}</Chip>
                {roleService.namesNoScope(role) ? <Chip tone="warning" className="ml-2">Check this</Chip> : null}
              </Td>
              <Td className="text-right tabular-nums">{role.permissions.length}</Td>
              <Td>
                <ActionForm action={removeRole} tone="danger" submit={`Remove ${role.name}`}
                            hidden={{ id: role.id }} className="flex flex-col items-start gap-2" />
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 text-base font-semibold">Make a role</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">
        Removing a role later puts its holders back on the preset their membership names, so nobody is
        locked out by it.
      </p>
      <ActionForm action={createRole} submit="Make the role" className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
        <TextField label="Name" name="name" required maxLength={100} placeholder="Branch manager" />
        <TextField label="What it is for (optional)" name="description" maxLength={300} />
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Start from</span>
          <select name="basedOn" defaultValue="office_manager"
                  className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
            {ROLE_IDS.filter((r) => r !== "owner").map((r) => (
              <option key={r} value={r}>{ROLE_PRESETS[r].label}: {ROLE_PRESETS[r].description}</option>
            ))}
          </select>
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-ink-700">What they see</legend>
          <div className="mt-2 space-y-2">
            {SEES.map((choice) => (
              <label key={choice.value} className="flex items-start gap-2 text-sm">
                <input type="radio" name="sees" value={choice.value} defaultChecked={choice.value === "business_unit"} className="mt-0.5 h-4 w-4" />
                <span><span className="font-medium">{choice.label}.</span> <span className="text-ink-700">{choice.meaning}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </ActionForm>
    </div>
  );
}
