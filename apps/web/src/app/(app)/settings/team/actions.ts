"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { team, roles, branches, ConflictError } from "@opentradesos/api/services";

/**
 * Getting people in, and deciding what each of them may do.
 *
 * `requireUser`, because the setup wizard's team step posts here before setup
 * is finished. Every decision is the service's: whether the role is one this
 * person may hand out, whether an address belongs to somebody else's account,
 * whether a branch can be taken away.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/settings/team");
  revalidatePath("/setup/team");
  revalidatePath("/settings");
}

/**
 * What the inviter is told: whether it was emailed, and the link either way.
 *
 * The link is shown as a secret rather than as a link: it signs somebody in
 * as a new person, once, and an anchor whose address is a credential leaks it
 * into history and into whatever it is clicked through to. It is shown even
 * when the email went, once, because "it went to spam" is the commonest reply
 * to an invite and the inviter is standing next to the person.
 */
function handOver(
  name: string,
  result: { link: string | null; reissued: boolean; emailed: boolean; emailNote: string | null },
): Partial<NonNullable<FormState>> {
  if (!result.link) {
    return {
      message: `${name} is set up. This server has no public address (PUBLIC_URL), so no link could be made `
        + "or emailed: set it, then press Send a new invite beside them.",
    };
  }
  const emailed = result.emailed
    ? `Emailed to them, with a link of its own.`
    : `Not emailed (${result.emailNote ?? "the email could not be sent"}), so send this to them yourself.`;
  return {
    secret: {
      value: result.link,
      caption: `${result.reissued ? "A new invite for" : "Invited"} ${name}. ${emailed} The link lets them choose a password, once, in the next seven days${result.reissued ? ", and the old invite no longer works" : ""}. It is not shown again.`,
    },
  };
}

export async function invite(_previous: FormState, form: FormData): Promise<FormState> {
  const name = field(form, "name") ?? "";
  const branch = field(form, "businessUnitId");
  return attempt(form, async () => {
    const result = await team.invite(await ctx(), {
      email: field(form, "email") ?? "",
      name,
      role: field(form, "role") ?? "",
      ...(branch ? { businessUnitId: branch } : {}),
      ...(form.get("goesOut") === "on" ? { goesOut: true } : {}),
    });
    refresh();
    return handOver(name, result);
  });
}

export async function resend(_previous: FormState, form: FormData): Promise<FormState> {
  const name = field(form, "name") ?? "them";
  return attempt(form, async () => {
    const result = await team.resendInvite(await ctx(), { membershipId: String(form.get("membershipId") ?? "") });
    refresh();
    return handOver(name, result);
  });
}

/**
 * A preset (`preset:technician`) or one of the company's own roles
 * (`role:<id>`). A custom role goes through `roles.assignCustomRole`, which
 * checks the same authority both ways, as a preset change does, and refuses
 * a branch role for somebody with no branch.
 */
export async function changeRole(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const choice = String(form.get("role") ?? "");
  const result = await attempt(form, async () => {
    const context = await ctx();
    if (choice.startsWith("role:")) {
      try {
        await roles.assignCustomRole(context, { membershipId, roleId: choice.slice("role:".length) });
      } catch (error) {
        if (error instanceof roles.RoleEscalationError) throw new ConflictError(error.sentence);
        throw error;
      }
      return { message: "Saved." };
    }
    await team.setRole(context, { membershipId, role: choice.replace(/^preset:/, "") });
    return { message: "Saved." };
  });
  refresh();
  return result;
}

export async function changeBranch(_previous: FormState, form: FormData): Promise<FormState> {
  const chosen = String(form.get("businessUnitId") ?? "");
  const result = await attempt(form, async () => {
    await branches.setMemberBranch(await ctx(), {
      membershipId: String(form.get("membershipId") ?? ""),
      businessUnitId: chosen === "" ? null : chosen,
    });
    return { message: "Saved." };
  });
  refresh();
  return result;
}

export async function setActive(_previous: FormState, form: FormData): Promise<FormState> {
  const active = form.get("active") === "true";
  const result = await attempt(form, async () => {
    const done = await roles.setMembershipActive(await ctx(), {
      membershipId: String(form.get("membershipId") ?? ""), active,
    });
    return {
      message: active
        ? "Turned back on. They can sign in again."
        : `Turned off.${done.sessionsRevoked > 0 ? ` Signed out of ${done.sessionsRevoked} ${done.sessionsRevoked === 1 ? "device" : "devices"}.` : ""}`,
    };
  });
  refresh();
  return result;
}

/** Which shop somebody works from: what a "their shop's work" role shows them. */
export async function changeLocation(_previous: FormState, form: FormData): Promise<FormState> {
  const chosen = String(form.get("locationId") ?? "");
  const result = await attempt(form, async () => {
    await branches.setMemberLocation(await ctx(), {
      membershipId: String(form.get("membershipId") ?? ""),
      locationId: chosen === "" ? null : chosen,
    });
    return { message: "Saved." };
  });
  refresh();
  return result;
}
