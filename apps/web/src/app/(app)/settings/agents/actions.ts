"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, parsed, refused, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@opentradesos/api/services";
import { configureAgent } from "@opentradesos/api/contracts";
import { agents as a } from "@opentradesos/core";

/**
 * Saving one agent's settings.
 *
 * The form carries every field an agent has, so what is posted is the whole
 * setting rather than a patch: a box left unticked means off, not "leave it".
 * Parsed through the route's own schema and saved through the same service the
 * API calls, so the refusals (somebody with more access than you, auto on an
 * agent that always waits, a limit out of range) are the service's sentences.
 */
export async function saveAgent(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const kind = String(form.get("agent") ?? "");
  if (!a.isAgentKind(kind)) return refused(form, "That is not one of the agents.");

  const number = (name: string, fallback: number) => {
    const raw = field(form, name);
    return raw === undefined ? fallback : Number(raw);
  };
  const ticked = (name: string) => form.get(name) === "yes";
  const base = a.defaultSettings(kind);

  /**
   * Questions and answers, one pair per block: the question on the first
   * line, the answer on the lines under it, a blank line between pairs. The
   * shape a person types into a box without reading instructions.
   */
  const faq = String(form.get("faq") ?? "").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
    .map((block) => {
      const [question, ...answer] = block.split("\n");
      return { question: (question ?? "").trim(), answer: answer.join("\n").trim() };
    });

  const steps = [0, 1, 2, 3, 4, 5].flatMap((i) => {
    const days = field(form, `stepDays${i}`);
    if (days === undefined) return [];
    return [{
      afterDays: Number(days),
      tone: field(form, `stepTone${i}`) ?? "",
      channel: form.get(`stepChannel${i}`) === "text" ? "text" as const : "email" as const,
    }];
  });

  const settings = {
    enabled: ticked("enabled"),
    mode: form.get("mode") === "auto" ? "auto" : "propose",
    tone: field(form, "tone") ?? base.tone,
    runAsUserId: field(form, "runAsUserId") ?? null,
    provider: field(form, "provider") ?? null,
    model: field(form, "model") ?? null,
    limits: {
      runsPerDay: number("runsPerDay", base.limits.runsPerDay),
      maxOutputTokens: number("maxOutputTokens", base.limits.maxOutputTokens),
      messagesPerChat: number("messagesPerChat", base.limits.messagesPerChat),
    },
    chat: {
      greeting: field(form, "greeting") ?? base.chat.greeting,
      faq,
      publicPriceItemIds: form.getAll("publicPriceItemIds").map(String).filter(Boolean),
      web: kind === "chat" ? ticked("web") : base.chat.web,
      text: kind === "chat" ? ticked("text") : base.chat.text,
    },
    intake: kind === "intake"
      ? { texts: ticked("texts"), emails: ticked("emails"), calls: ticked("calls"), forms: ticked("forms") }
      : base.intake,
    collections: { steps: kind === "collections" ? steps : base.collections.steps },
  };

  const state = await attempt(form, () => agents.configure(ctx, parsed(configureAgent.input, { agent: kind, settings })));
  revalidatePath("/settings/agents");
  return state?.done ? { done: true, message: "Saved." } : state;
}
