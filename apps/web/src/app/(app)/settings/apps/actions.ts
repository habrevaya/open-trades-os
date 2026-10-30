"use server";

import { attempt, field, fields, refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { todayIn } from "@/lib/dates";
import { getDb } from "@/lib/db";
import { apps, appRequestReminders, plugins } from "@opentradesos/api/services";

export type AppsState = FormState;

/**
 * Letting an application in, changing what it may do, and killing a credential.
 *
 * Every refusal is the service's own, and the two that matter are the ones a
 * screen must not soften. A grant wider than what the installer holds is refused
 * naming the permissions, and a permission that does not exist is refused rather
 * than dropped: dropping it produces an app that looks correctly limited in this
 * list and is limited by accident, and the release that adds the permission turns
 * it on with nobody having approved it.
 */
export async function act(_previous: AppsState, form: FormData): Promise<AppsState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const op = String(form.get("op") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "install":
        return apps.install(ctx, {
          name: field(form, "name") ?? "",
          publisher: field(form, "publisher"),
          permissions: fields(form, "permissions"),
          scopes: scopesFrom(form),
        });

      case "issue": {
        /**
         * THE ONE ACTION WHOSE ANSWER IS A SECRET.
         *
         * Returned as `secret` rather than `message`, so `ActionForm` draws it as
         * selectable text with the sentence saying it will not be shown again. It
         * is deliberately not `link`, which renders an anchor: an anchor whose
         * href is a credential puts it in the browser's history and in the
         * `Referer` of whatever it is clicked through to.
         */
        const issued = await apps.issueToken(ctx, {
          appId: String(form.get("appId") ?? ""),
          ...(field(form, "label") ? { label: field(form, "label")! } : {}),
          ...(field(form, "expiresInDays")
            ? { expiresInDays: Number(field(form, "expiresInDays")) }
            : {}),
        });
        return {
          secret: {
            value: issued.token,
            caption:
              `Copy this now. It is not stored and cannot be shown again, and it expires on `
              + `${todayIn(user.organizationTimezone, issued.expiresAt)}.`,
          },
        };
      }

      case "revoke-token":
        await apps.revokeToken(ctx, { tokenId: String(form.get("tokenId") ?? "") });
        return { message: "That credential is dead on its next use." };

      case "revoke":
        await apps.revoke(ctx, {
          id: String(form.get("id") ?? ""),
          ...(field(form, "reason") ? { reason: field(form, "reason")! } : {}),
        });
        return { message: "Turned off, and its credentials with it." };

      case "approve": {
        const { app, returnTo } = await apps.approve(ctx, {
          id: String(form.get("id") ?? ""), permissions: fields(form, "permissions"),
        });
        const leftOut = (app.requestedPermissions ?? []).filter((p) => !app.permissions.includes(p)).length;
        return {
          message: leftOut > 0
            ? `${app.name} is approved, with ${leftOut} of what it asked for left out. It collects its credential itself, once, and is told what was left out.`
            : `${app.name} is approved. It collects its credential itself, once.`,
          ...(returnTo ? { link: returnTo } : {}),
        };
      }

      /**
       * One thing an application added, stopped or started again on its own.
       * The application is not turned off and nothing it did before is undone:
       * the next thing priced, moved or reported on simply leaves it out, or
       * takes it back in.
       */
      case "plugin-off": {
        const { plugin } = await plugins.switchPlugin(ctx, {
          id: String(form.get("id") ?? ""), on: false,
          ...(field(form, "reason") ? { reason: field(form, "reason")! } : {}),
        });
        return { message: `${plugin.name} is turned off. ${plugin.appName} carries on with the rest.` };
      }

      case "plugin-on": {
        const { plugin } = await plugins.switchPlugin(ctx, { id: String(form.get("id") ?? ""), on: true });
        return { message: `${plugin.name} is on again.` };
      }

      case "refuse": {
        const { app, returnTo } = await apps.refuse(ctx, {
          id: String(form.get("id") ?? ""),
          ...(field(form, "reason") ? { reason: field(form, "reason")! } : {}),
        });
        return {
          message: `${app.name} was refused and holds nothing.`,
          ...(returnTo ? { link: returnTo } : {}),
        };
      }

      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });

  if (state?.done) {
    revalidatePath("/settings/apps");
    revalidatePath("/settings/apps/added");
    if (op === "approve" || op === "refuse") revalidatePath(`/settings/apps/requests/${String(form.get("id") ?? "")}`);
  }
  return state;
}

/**
 * The record scope per resource, dropping the ones left blank.
 *
 * A resource nobody chose is deliberately absent rather than sent as `all`: the
 * service refuses a scope wider than the installer's own, and quietly widening on
 * their behalf is how a screen grants something nobody asked for.
 */
function scopesFrom(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("scope.")) continue;
    if (typeof value !== "string" || value === "") continue;
    out[key.slice("scope.".length)] = value;
  }
  return out;
}

/**
 * When the people who could approve an application are reminded that it is still
 * waiting. Whole days, or empty for no reminder; the service refuses a number a
 * request would not live to see.
 */
export async function setRequestReminder(_previous: AppsState, form: FormData): Promise<AppsState> {
  const said = field(form, "days");
  const days = said === undefined ? null : Number(said);
  if (days !== null && !Number.isInteger(days)) return refused(form, "Give the days as a whole number, or leave it empty.");
  const result = await attempt(form, async () => {
    const saved = await appRequestReminders.setReminder({ actor: (await requireSetupUser()).actor, db: getDb() }, { days });
    return {
      message: saved.days === null
        ? "Saved. Nobody is reminded about a request that is waiting."
        : `Saved. Whoever can approve is reminded once, ${saved.days} ${saved.days === 1 ? "day" : "days"} after an application asks.`,
    };
  });
  revalidatePath("/settings/apps");
  return result;
}
