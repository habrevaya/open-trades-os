import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents, ai, team, priceBook, phoneMenus } from "@opentradesos/api/services";
import { can, type agents as coreAgents } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { saveAgent } from "./actions";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → AI AGENTS
 *
 * One card per agent: on or off, who it acts as, whether it proposes or acts
 * on its own, how it sounds, its limits, and what it may actually do as that
 * person. Then the log of everything the agents did, including every time one
 * was refused.
 *
 * "What it may do" is read from the person's real permissions, not described,
 * because the honest answer to "what can this agent do" is a list an owner can
 * check against the person they chose.
 */

const ACTION_WORDS: Record<string, string> = {
  propose_booking: "Draft bookings",
  not_a_booking: "Set aside messages that are not bookings",
  reply: "Answer customers",
  create_booking_request: "Take booking requests",
  hand_off: "Hand over to a person",
  draft_estimate: "Draft estimate options",
  cannot_estimate: "Say when notes are not enough",
  draft_reminder: "Draft and send overdue reminders",
  propose_assignments: "Propose assignments",
  look_up_customer: "Look callers up among your customers",
  take_message: "Take messages for the office",
  transfer: "Put callers through to a person",
  end_call: "Say goodbye when the caller is done",
  answer: "Answer technicians from your records and notes",
  not_in_records: "Say when your records do not answer it",
};

const KIND_WORDS: Record<string, string> = {
  settings: "Settings", drafted: "Drafted", applied: "Applied", dismissed: "Dismissed", refused: "Refused",
  failed: "Failed", answered: "Answered", handed_off: "Handed over", skipped: "Skipped",
};

const KIND_TONE: Record<string, "neutral" | "success" | "danger" | "warning" | "info"> = {
  applied: "success", refused: "danger", failed: "danger", handed_off: "warning", skipped: "warning", drafted: "info",
};

const CHECK = "flex items-center gap-2 text-sm";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;

  if (!can(user.actor, "integration:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="AI agents" />
        <Empty title="Not shown to your role">Seeing the AI agents needs the View connected integrations permission.</Empty>
      </div>
    );
  }

  const writes = can(user.actor, "agent:configure");
  const [listed, status, roster, items, ringGroups] = await Promise.all([
    agents.list(ctx),
    ai.status(ctx),
    can(user.actor, "user:read") ? team.roster(ctx) : Promise.resolve([]),
    can(user.actor, "pricebook:read") ? priceBook.list(ctx, { limit: 200, includeInactive: false }).then((r) => r.data) : Promise.resolve([]),
    can(user.actor, "settings:read") ? phoneMenus.listRingGroups(ctx) : Promise.resolve([]),
  ]);
  const filter = listed.agents.some((x) => x.agent === params.agent) ? params.agent as coreAgents.AgentKind : undefined;
  const log = await agents.activity(ctx, { agent: filter, limit: 100 });
  const people = roster.filter((m) => m.active);
  const connected = status.connections.filter((c) => c.connected);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="AI agents" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Each agent uses your own model account and acts as a person you choose, never with more access than
        they have. Anything that moves money or a customer&apos;s appointment waits for a person unless you let
        that agent act on its own, and everything they do is in the log below.
      </p>
      {connected.length === 0 ? (
        <p className="mt-3 rounded-md border border-amber-700 bg-amber-tint px-4 py-3 text-sm text-ink-900">
          No model is connected yet, so no agent can run. Connect one under{" "}
          <a href="/settings/integrations" className="underline underline-offset-4">Integrations</a>, and set a monthly
          spending limit while you are there.
        </p>
      ) : null}

      {listed.agents.map((agent) => (
        <section key={agent.agent} aria-label={agent.label} className="mt-8 rounded-md border border-steel-200 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">{agent.label}</h2>
            <div className="flex items-center gap-2">
              <Chip tone={agent.settings.enabled ? "success" : "neutral"}>{agent.settings.enabled ? "On" : "Off"}</Chip>
              {agent.settings.enabled ? (
                <Chip tone={agent.settings.mode === "auto" ? "warning" : "info"}>
                  {agent.settings.mode === "auto" ? "Acts on its own" : "Proposes"}
                </Chip>
              ) : null}
              <span className="text-xs text-ink-500">{agent.runsToday} runs today</span>
            </div>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">{agent.description}</p>
          {agent.agent === "field" ? (
            <p className="mt-2 text-sm text-ink-700">
              It answers how your company does a job only from your{" "}
              <a href="/settings/agents/notes" className="underline underline-offset-4">how-to notes</a>.
            </p>
          ) : null}
          {agent.runAs ? (
            <p className="mt-2 text-sm text-ink-700">
              Acts as {agent.runAs.name ?? "a former member"}
              {agent.runAs.active
                ? agent.runAs.actions.length > 0
                  ? `, and so may: ${agent.runAs.actions.map((name) => ACTION_WORDS[name] ?? name).join(", ").toLowerCase()}.`
                  : ", who may not do anything this agent does."
                : ", who is no longer an active member, so it has stopped."}
              {agent.runAs.missing.length > 0 ? ` They cannot read what it needs: ${agent.runAs.missing.join(", ")}.` : null}
            </p>
          ) : null}

          {writes ? (
            <ActionForm action={saveAgent} submit={`Save ${agent.label.toLowerCase()}`} hidden={{ agent: agent.agent }}
                        className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <label className={CHECK}>
                  <input type="checkbox" name="enabled" value="yes" defaultChecked={agent.settings.enabled} />
                  On
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Acts as" name="runAsUserId" defaultValue={agent.settings.runAsUserId ?? ""}
                        options={[
                          { value: "", label: agent.agent === "estimate" || agent.agent === "dispatch" || agent.agent === "field" ? "Whoever asks it" : "Nobody yet" },
                          ...people.map((p) => ({ value: p.userId, label: `${p.name ?? p.email} (${p.roleLabel})` })),
                        ]} />
                {agent.autoAllowed ? (
                  <Select label="When it has a draft" name="mode" defaultValue={agent.settings.mode}
                          options={[
                            { value: "propose", label: "Wait for a person to approve it" },
                            { value: "auto", label: agent.agent === "estimate" ? "Make the draft estimate on its own" : "Act on its own" },
                          ]} />
                ) : (
                  <p className="self-end text-sm text-ink-500">Always waits for a person.</p>
                )}
              </div>
              <TextArea label="How it should sound" name="tone" rows={2} defaultValue={agent.settings.tone} maxLength={300} />
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="Runs a day, at most" name="runsPerDay" type="number" min={1} max={5000}
                           defaultValue={String(agent.settings.limits.runsPerDay)} />
                <TextField label="Longest answer, in tokens" name="maxOutputTokens" type="number" min={200} max={16000}
                           defaultValue={String(agent.settings.limits.maxOutputTokens)} />
                {agent.agent === "chat" || agent.agent === "voice" ? (
                  <TextField label={agent.agent === "voice" ? "Replies on one call before it puts the caller through" : "Replies in one chat before a person takes over"}
                             name="messagesPerChat" type="number" min={2} max={100}
                             defaultValue={String(agent.settings.limits.messagesPerChat)} />
                ) : <input type="hidden" name="messagesPerChat" value={String(agent.settings.limits.messagesPerChat)} />}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Model account" name="provider" defaultValue={agent.settings.provider ?? ""}
                        options={[
                          { value: "", label: connected.length === 1 ? `The one connected (${connected[0]!.provider})` : "Choose one" },
                          ...connected.map((c) => ({ value: c.provider, label: c.accountLabel ?? c.provider })),
                        ]} />
                <TextField label="Model, if not the account's default" name="model" defaultValue={agent.settings.model ?? ""} />
              </div>

              {agent.agent === "intake" ? (
                <fieldset>
                  <legend className="text-sm font-medium text-ink-700">What it reads</legend>
                  <div className="mt-1 flex flex-wrap gap-4">
                    <label className={CHECK}><input type="checkbox" name="texts" value="yes" defaultChecked={agent.settings.intake.texts} />Texts</label>
                    <label className={CHECK}><input type="checkbox" name="emails" value="yes" defaultChecked={agent.settings.intake.emails} />Emails</label>
                    <label className={CHECK}><input type="checkbox" name="calls" value="yes" defaultChecked={agent.settings.intake.calls} />Call transcripts</label>
                    <label className={CHECK}><input type="checkbox" name="forms" value="yes" defaultChecked={agent.settings.intake.forms} />Web forms</label>
                  </div>
                </fieldset>
              ) : null}

              {agent.agent === "voice" ? (
                <>
                  <TextField label="What it says after saying it is automated" name="greeting" defaultValue={agent.settings.chat.greeting} maxLength={300} />
                  <TextArea label="Your questions and answers (question on the first line, the answer under it, a blank line between each)"
                            name="faq" rows={6}
                            defaultValue={agent.settings.chat.faq.map((f) => `${f.question}\n${f.answer}`).join("\n\n")} />
                  {items.length > 0 ? (
                    <label className="block">
                      <span className="text-sm font-medium text-ink-700">
                        Prices it may say out loud (your online booking prices are always public)
                      </span>
                      <select name="publicPriceItemIds" multiple size={6} defaultValue={agent.settings.chat.publicPriceItemIds}
                              className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm">
                        {items.map((item) => <option key={item.id} value={item.id}>{`${item.name}, ${item.price}`}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <Select label="When a caller asks for a person, or it is unsure, it puts them through to" name="transferRingGroupId"
                          defaultValue={agent.settings.voice.transferRingGroupId ?? ""} className="block"
                          options={[
                            { value: "", label: "Voicemail" },
                            ...ringGroups.map((g) => ({ value: g.id, label: `The ${g.name} ring group` })),
                          ]} />
                  <p className="text-sm text-ink-500">
                    It always says first that it is an automated assistant and that the call is written down, and puts
                    the caller through when they ask for a person or press 0. Send calls to it from a menu option or after
                    hours on <a href="/settings/phone" className="underline underline-offset-4">Phone menus</a>.
                  </p>
                </>
              ) : null}

              {agent.agent === "chat" ? (
                <>
                  <fieldset>
                    <legend className="text-sm font-medium text-ink-700">Where it answers</legend>
                    <div className="mt-1 flex flex-wrap gap-4">
                      <label className={CHECK}><input type="checkbox" name="web" value="yes" defaultChecked={agent.settings.chat.web} />Your website</label>
                      <label className={CHECK}><input type="checkbox" name="text" value="yes" defaultChecked={agent.settings.chat.text} />Texts to your number</label>
                    </div>
                  </fieldset>
                  <TextField label="What it says first" name="greeting" defaultValue={agent.settings.chat.greeting} maxLength={300} />
                  <TextArea label="Your questions and answers (question on the first line, the answer under it, a blank line between each)"
                            name="faq" rows={6}
                            defaultValue={agent.settings.chat.faq.map((f) => `${f.question}\n${f.answer}`).join("\n\n")} />
                  {items.length > 0 ? (
                    <label className="block">
                      <span className="text-sm font-medium text-ink-700">
                        Prices it may say out loud (your online booking prices are always public)
                      </span>
                      <select name="publicPriceItemIds" multiple size={6} defaultValue={agent.settings.chat.publicPriceItemIds}
                              className="mt-1 w-full rounded border border-steel-300 bg-canvas px-3 py-2 text-sm">
                        {items.map((item) => <option key={item.id} value={item.id}>{`${item.name}, ${item.price}`}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <p className="text-sm text-ink-500">
                    It always says it is an automated assistant first, and hands over to a person when asked. Add it to
                    your website with the snippet on <a href="/settings/website" className="underline underline-offset-4">Website</a>.
                  </p>
                </>
              ) : agent.agent === "voice" ? null : (
                agent.settings.chat.publicPriceItemIds.map((value) => <input key={value} type="hidden" name="publicPriceItemIds" value={value} />)
              )}

              {agent.agent === "collections" ? (
                <fieldset>
                  <legend className="text-sm font-medium text-ink-700">Steps, by days past the due date</legend>
                  <div className="mt-1 space-y-2">
                    {[0, 1, 2, 3, 4, 5].map((i) => {
                      const step = agent.settings.collections.steps[i];
                      return (
                        <div key={i} className="grid gap-2 sm:grid-cols-[6rem_1fr_8rem]">
                          <TextField label="Days" name={`stepDays${i}`} type="number" min={0} max={365}
                                     defaultValue={step ? String(step.afterDays) : ""} />
                          <TextField label="How it should sound" name={`stepTone${i}`} defaultValue={step?.tone ?? ""} maxLength={200} />
                          <Select label="By" name={`stepChannel${i}`} defaultValue={step?.channel ?? "email"}
                                  options={[{ value: "email", label: "Email" }, { value: "text", label: "Text" }]} />
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-sm text-ink-500">Leave a row&apos;s days empty to drop it. Texts never go in your quiet hours.</p>
                </fieldset>
              ) : null}
            </ActionForm>
          ) : null}
        </section>
      ))}

      <section aria-label="What the agents did" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">What the agents did</h2>
          <nav className="flex flex-wrap gap-3 text-sm">
            <a href="/settings/agents" className={filter ? "text-ink-500 hover:underline" : "font-medium"}>All</a>
            {listed.agents.map((x) => (
              <a key={x.agent} href={`/settings/agents?agent=${x.agent}`}
                 className={filter === x.agent ? "font-medium" : "text-ink-500 hover:underline"}>{x.label}</a>
            ))}
          </nav>
        </div>
        {log.entries.length === 0 ? (
          <Empty title="Nothing yet">Every draft, decision, refusal and handover will be listed here.</Empty>
        ) : (
          <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200">
            {log.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-2 p-3 text-sm">
                <Chip tone={KIND_TONE[entry.kind] ?? "neutral"}>{KIND_WORDS[entry.kind] ?? entry.kind}</Chip>
                <span className="text-ink-500">{listed.agents.find((x) => x.agent === entry.agent)?.label}</span>
                <span className="text-ink-900">{entry.detail}</span>
                <span className="ml-auto text-xs text-ink-500">
                  {entry.automatic ? "on its own · " : entry.actorName ? `${entry.actorName} · ` : ""}
                  {formatIn(entry.at, user.organizationTimezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
