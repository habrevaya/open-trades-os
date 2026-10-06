import { team, roles as roleService, branches, company, type ServiceContext } from "@opentradesos/api/services";
import { can, canDefineRole, presetDefinition, ROLE_IDS, ROLE_PRESETS } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty } from "@/components/Table";
import { invite, resend, changeRole, changeBranch, changeLocation, setActive } from "./actions";

/**
 * WHO WORKS HERE, AND GETTING THE NEXT PERSON IN
 *
 * Drawn on Settings, Team and on the setup wizard's team step. Inviting makes
 * the person, puts them in a branch, gives anybody who goes out to jobs a
 * place on the board, emails them a link to choose a password, and shows the
 * inviter a link of their own, once. Somebody who has not signed in yet says
 * whether their invite was emailed and until when it works, and an invite
 * that ran out is sent again from here. The roles offered are the ones the
 * person inviting could hand out at all: an office manager is not shown
 * Owner, because they cannot give it, and a list of choices that are refused
 * is a list of traps.
 */
export async function TeamSection({ ctx }: { ctx: ServiceContext }) {
  const actor = ctx.actor;
  const reads = can(actor, "user:read");
  const invites = can(actor, "user:invite");
  const changesRoles = can(actor, "user:write");
  const assigns = can(actor, "membership:write");

  const people = reads ? await team.roster(ctx) : [];
  const options = await branches.options(ctx).catch(() => null);
  const branchList = options?.branches ?? [];
  const customRoles = can(actor, "role:write") ? await roleService.list(ctx) : [];
  /** Shops, for a company that has said which building people work from. */
  const shops = assigns ? (await company.listLocations(ctx).catch(() => [])).filter((l) => l.active) : [];

  /** The presets this person may hand out, by the rule the service applies. */
  const givable = ROLE_IDS.filter((role) => canDefineRole(actor, presetDefinition(role)).ok);
  const roleChoices = [
    ...givable.map((role) => ({ value: `preset:${role}`, label: ROLE_PRESETS[role].label })),
    ...customRoles.map((role) => ({ value: `role:${role.id}`, label: `${role.name} (your own role)` })),
  ];

  return (
    <div>
      {invites ? (
        <section aria-labelledby="invite">
          <h2 id="invite" className="text-base font-semibold">Invite somebody</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            They are emailed a link to choose their own password, and you are shown one too, once, to send
            however you talk to your team if the email does not arrive. Both work for seven days. An address
            that already has an account with another company cannot be added here; ask them for a different one.
            A branch manager sees their branch&apos;s work only, so choose their branch.
            {!givable.includes("technician") ? " Technicians are invited by an owner or an administrator, because the role carries field permissions yours does not." : ""}
          </p>
          <ActionForm action={invite} submit="Invite" className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
            <TextField label="Their name" name="name" required maxLength={120} autoComplete="off" />
            <TextField label="Their email" name="email" type="email" required maxLength={254} autoComplete="off" />
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Role</span>
              <select name="role" required defaultValue={givable.includes("technician") ? "technician" : givable[0]}
                      className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                {givable.map((role) => (
                  <option key={role} value={role}>{ROLE_PRESETS[role].label}: {ROLE_PRESETS[role].description}</option>
                ))}
              </select>
            </label>
            {branchList.length > 0 ? (
              <label className="block">
                <span className="text-sm font-medium text-ink-700">Branch</span>
                <select name="businessUnitId" defaultValue={options?.yours ?? ""}
                        className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                  <option value="">No branch</option>
                  {branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="goesOut" className="h-4 w-4" />
              Goes out to jobs, so they need a place on the board. Technicians and crew leads always get one.
            </label>
          </ActionForm>
        </section>
      ) : null}

      <section aria-labelledby="people" className={invites ? "mt-10" : ""}>
        <h2 id="people" className="text-base font-semibold">Who works here</h2>
        {!reads ? (
          <Empty title="Not shown to your role">Seeing who works here needs the View users permission.</Empty>
        ) : people.length === 0 ? (
          <Empty title="Nobody yet">Invite the first person above.</Empty>
        ) : (
          <Table head={<><Th>Person</Th><Th>Role</Th>{branchList.length > 0 ? <Th>Branch</Th> : null}{shops.length > 0 ? <Th>Shop</Th> : null}<Th>{""}</Th></>}>
            {people.map((person) => (
              <tr key={person.membershipId}>
                <Td>
                  <span className="font-medium">{person.name ?? person.email}</span>
                  {person.name ? <span className="block text-xs text-ink-500">{person.email}</span> : null}
                  <span className="mt-1 flex flex-wrap gap-1">
                    {person.isYou ? <Chip tone="info">You</Chip> : null}
                    {!person.active ? <Chip tone="neutral">Turned off</Chip> : null}
                    {person.active && person.waiting
                      ? <Chip tone={person.invite?.expired ? "danger" : "warning"}>{person.invite?.expired ? "Invite ran out" : "Has not signed in yet"}</Chip>
                      : null}
                    {person.technicianId ? <Chip tone="neutral">On the board</Chip> : null}
                  </span>
                  {person.active && person.waiting && person.invite
                    ? <span className="mt-1 block max-w-xs text-xs text-ink-500">{person.invite.sentence}</span>
                    : null}
                </Td>
                <Td>
                  {(changesRoles || assigns) && !person.isYou && person.active ? (
                    <ActionForm action={changeRole} tone="quiet" submit="Change role"
                                hidden={{ membershipId: person.membershipId }}
                                className="flex flex-wrap items-end gap-2">
                      <select
                        name="role" aria-label={`Role for ${person.name ?? person.email}`}
                        defaultValue={person.customRoleId ? `role:${person.customRoleId}` : `preset:${person.role}`}
                        className="h-9 rounded border border-steel-300 px-2 text-sm"
                      >
                        {!roleChoices.some((c) => c.value === (person.customRoleId ? `role:${person.customRoleId}` : `preset:${person.role}`)) ? (
                          <option value={person.customRoleId ? `role:${person.customRoleId}` : `preset:${person.role}`}>
                            {person.customRoleName ?? person.roleLabel}
                          </option>
                        ) : null}
                        {roleChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </ActionForm>
                  ) : (
                    <span className="text-ink-700">{person.customRoleName ?? person.roleLabel}</span>
                  )}
                </Td>
                {branchList.length > 0 ? (
                  <Td>
                    {assigns && person.active ? (
                      <ActionForm action={changeBranch} tone="quiet" submit="Move"
                                  hidden={{ membershipId: person.membershipId }}
                                  className="flex flex-wrap items-end gap-2">
                        <select name="businessUnitId" defaultValue={person.businessUnitId ?? ""}
                                aria-label={`Branch for ${person.name ?? person.email}`}
                                className="h-9 rounded border border-steel-300 px-2 text-sm">
                          <option value="">No branch</option>
                          {branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </ActionForm>
                    ) : (
                      <span className="text-ink-700">{person.branchName ?? "None"}</span>
                    )}
                  </Td>
                ) : null}
                {shops.length > 0 ? (
                  <Td>
                    {person.active ? (
                      <ActionForm action={changeLocation} tone="quiet" submit="Move"
                                  hidden={{ membershipId: person.membershipId }}
                                  className="flex flex-wrap items-end gap-2">
                        <select name="locationId" defaultValue={person.locationId ?? ""}
                                aria-label={`Shop for ${person.name ?? person.email}`}
                                className="h-9 rounded border border-steel-300 px-2 text-sm">
                          <option value="">No shop</option>
                          {shops.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      </ActionForm>
                    ) : (
                      <span className="text-ink-700">{person.locationName ?? "None"}</span>
                    )}
                  </Td>
                ) : null}
                <Td>
                  <div className="flex flex-wrap gap-2">
                    {invites && person.active && person.waiting ? (
                      <ActionForm action={resend} tone="quiet" submit="Send a new invite"
                                  hidden={{ membershipId: person.membershipId, name: person.name ?? person.email }}
                                  className="flex flex-col items-start gap-2" />
                    ) : null}
                    {changesRoles && !person.isYou ? (
                      <ActionForm
                        action={setActive} tone={person.active ? "danger" : "quiet"}
                        submit={person.active ? "Turn off" : "Turn back on"}
                        hidden={{ membershipId: person.membershipId, active: person.active ? "false" : "true" }}
                        className="flex flex-col items-start gap-2"
                      />
                    ) : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
