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
 * The link is shown as a secret rather than as a link: it signs somebody in
 * as a new person, once, and an anchor whose address is a credential leaks it
 * into history and into whatever it is clicked through to.
 */
function handOver(name: string, link: string | null, reissued: boolean): Partial<NonNullable<FormState>> {
  if (!link) {
    return {
      message: `${name} is set up. This server has no public address (PUBLIC_URL), so no link could be made: `
        + "set it, then press New link beside them.",
    };
  }
  return {
    secret: {
      value: link,
      caption: `${reissued ? "A new link for" : "Send this to"} ${name}. It lets them choose a password, once, in the next seven days${reissued ? ", and the old one no longer works" : ""}. It is not shown again.`,
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
    return handOver(name, result.link, result.reissued);
  });
}

export async function resend(_previous: FormState, form: FormData): Promise<FormState> {
  const name = field(form, "name") ?? "them";
  return attempt(form, async () => {
    const result = await team.resendInvite(await ctx(), { membershipId: String(form.get("membershipId") ?? "") });
    refresh();
    return handOver(name, result.link, true);
  });
}

/**
 * A preset (`preset:technician`) or one of the company's own roles
 * (`role:<id>`). A custom role goes through `roles.assign`, which checks the
 * same authority and refuses a branch role for somebody with no branch.
 */
export async function changeRole(_previous: FormState, form: FormData): Promise<FormState> {
  const membershipId = String(form.get("membershipId") ?? "");
  const choice = String(form.get("role") ?? "");
  const result = await attempt(form, async () => {
    const context = await ctx();
    if (choice.startsWith("role:")) {
      try {
        await roles.assign(context, { membershipId, roleId: choice.slice("role:".length) });
      } catch (error) {
        if (error instanceof roles.RoleEscalationError) {
          throw new ConflictError(
            `You cannot give somebody that role, because it carries more than you hold yourself (${error.message.replace(/^You do not hold: /, "")}).`,
          );
        }
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
