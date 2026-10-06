"use server";

import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { oauth } from "@opentradesos/api/services";

/**
 * The person's answer, sent back to the client.
 *
 * The request is checked again from the posted fields rather than trusted
 * from the page that showed it: the page is the person's view, the check is
 * the decision, and a form can be posted by anything. Approving runs through
 * the service's own authority check, so the same refusal an install by hand
 * gets is the one this gets.
 */
function paramsOf(form: FormData): oauth.AuthorizeParams {
  const out: Record<string, string> = {};
  for (const name of oauth.AUTHORIZE_PARAMS) {
    const value = form.get(name);
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out as oauth.AuthorizeParams;
}

export async function answer(form: FormData): Promise<void> {
  const user = await requireSetupUser();
  const db = getDb();
  const check = await oauth.checkAuthorization(db, paramsOf(form));
  if (check.kind === "stop") redirect(`/oauth/authorize?${new URLSearchParams({ client_id: String(form.get("client_id") ?? "") })}`);
  if (check.kind === "bounce") redirect(check.to);

  if (form.get("decision") !== "approve") redirect(oauth.refuseAuthorization(check));

  /**
   * What the person left ticked. Only when the boxes were on the page: a
   * form without them (nothing could be given) has no answer to narrow by,
   * and reading its absence as "nothing ticked" would refuse a yes.
   */
  const choice = form.get("narrow") === "1"
    ? { permissions: form.getAll("grant").filter((value): value is string => typeof value === "string") }
    : {};

  let to: string;
  try {
    to = (await oauth.approveAuthorization({ actor: user.actor, db }, check, choice)).redirectTo;
  } catch (error) {
    /**
     * A refusal from the authority check is told to the client as
     * `access_denied` with the sentence, which is what OAuth has for "the
     * person could not give you this", rather than an error page the person
     * cannot do anything with.
     */
    to = oauth.errorRedirect(check.redirectUri, "access_denied", (error as Error).message, check.state);
  }
  redirect(to);
}
