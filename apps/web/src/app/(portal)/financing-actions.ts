"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { financing } from "@opentradesos/api/services";
import { field, refused, refusalOf, type FormState } from "@/lib/actions";

/**
 * APPLY FOR FINANCING, from the customer's own invoice or estimate link.
 *
 * The amount and the customer come from the grant behind the token, never
 * from the form, and the customer is sent to the lender's own page to apply:
 * nothing about their credit is asked for or kept here. Pressing it twice
 * lands on the same application.
 */
export async function applyForFinancing(_previous: FormState, form: FormData): Promise<FormState> {
  const token = field(form, "token") ?? "";
  let url: string;
  try {
    url = (await financing.applyFromLink(getDb(), { token, optionId: field(form, "optionId") })).url;
  } catch (error) {
    const said = refusalOf(error);
    return refused(form, said ?? "The application could not be opened just now. Reply to the message that brought you here and the office will send you the link.");
  }
  redirect(url);
}
