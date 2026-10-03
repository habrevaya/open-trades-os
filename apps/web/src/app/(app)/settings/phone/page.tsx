import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { phoneMenus, phoneNumbers, transcription } from "@opentradesos/api/services";
import { assertCan, can, voice, type telephony } from "@opentradesos/core";
import { Chip, Phone } from "@opentradesos/ui";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm, TextField, TextArea, Select } from "@/components/ActionForm";
import {
  saveMenu, saveRingGroup, deleteMenu, deleteRingGroup, setAnsweringPhone, setNumberMenu, answerHere, stopAnswering,
} from "./actions";

export const dynamic = "force-dynamic";

type Choices = Awaited<ReturnType<typeof phoneMenus.choices>>;
type Destination = telephony.RoutingDestination;

const FIELD = "h-10 rounded border border-steel-300 bg-canvas px-2 text-sm";

/** How a destination is posted by a picker: `kind:id`, or `forward` with the number beside it. */
function encode(to: Destination | null | undefined): string {
  if (!to) return "";
  switch (to.kind) {
    case "person": return `person:${to.userId}`;
    case "ring_group": return `ring_group:${to.id}`;
    case "ivr": return `ivr:${to.menu}`;
    case "on_call_rota": return `on_call_rota:${to.id}`;
    case "voicemail": return "voicemail:main";
    case "forward": return "forward";
    default: return "";
  }
}

/**
 * Where a call can be sent, in the owner's own names.
 *
 * One picker for every place a destination is chosen (an option, a caller
 * who presses nothing, after hours, a group nobody answers), so the same
 * words mean the same thing everywhere on the screen. A person with no
 * number to ring is shown with that said, so nobody chooses them and is
 * then refused.
 */
function Destinations({
  name, numberName, label, choices, value, allowNone,
}: {
  name: string; numberName: string; label: string; choices: Choices;
  value?: Destination | null | undefined; allowNone?: string | undefined;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="text-sm font-medium text-ink-700">{label}</span>
        <select name={name} defaultValue={encode(value)} className={`mt-1 block ${FIELD}`}>
          {allowNone ? <option value="">{allowNone}</option> : null}
          <option value="voicemail:main">Voicemail</option>
          <optgroup label="A person">
            {choices.people.map((p) => (
              <option key={p.userId} value={`person:${p.userId}`}>
                {p.name}{p.phone ? "" : " (no number yet)"}
              </option>
            ))}
          </optgroup>
          {choices.ringGroups.length > 0 ? (
            <optgroup label="A ring group">
              {choices.ringGroups.map((g) => <option key={g.id} value={`ring_group:${g.id}`}>{g.name}</option>)}
            </optgroup>
          ) : null}
          {choices.menus.length > 0 ? (
            <optgroup label="Another menu">
              {choices.menus.map((m) => <option key={m.id} value={`ivr:${m.id}`}>{m.name}</option>)}
            </optgroup>
          ) : null}
          <optgroup label="On call">
            <option value="on_call_rota:company">Whoever is on call</option>
            {choices.branches.map((b) => (
              <option key={b.id} value={`on_call_rota:${b.id}`}>Whoever is on call for {b.name}</option>
            ))}
          </optgroup>
          <option value="forward">A number outside the company</option>
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-ink-500">Number, if outside</span>
        <input name={numberName} defaultValue={value?.kind === "forward" ? value.e164 : ""}
               placeholder="(512) 555-0147" className={`mt-1 block w-40 ${FIELD}`} />
      </label>
    </div>
  );
}

/** Spare rows on a menu form, so an option can be added without any script. */
const SPARE_OPTIONS = 3;

function MenuForm({ menu, choices }: { menu?: phoneMenus.MenuView | undefined; choices: Choices }) {
  const rows = [...(menu?.options ?? []), ...Array.from({ length: SPARE_OPTIONS }, () => null)];
  return (
    <ActionForm action={saveMenu} submit={menu ? "Save menu" : "Build menu"} done="Saved."
                hidden={menu ? { id: menu.id } : {}} className="mt-3 space-y-4">
      <TextField label="Name" name="name" required defaultValue={menu?.name ?? ""} placeholder="Main" />
      <TextArea label="What callers hear first" name="greeting" rows={2} required
                defaultValue={menu?.greeting ?? ""} placeholder="Thanks for calling Smith Heating and Air." />
      <p className="text-xs text-ink-500">
        The options are read out after this, from the list below, so you do not need to list them here.
      </p>
      <fieldset className="space-y-3 rounded-md border border-steel-200 p-3">
        <legend className="px-1 text-sm font-medium">Options</legend>
        {rows.map((option, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 border-b border-steel-200 pb-3 last:border-0 last:pb-0">
            <label className="block">
              <span className="text-sm font-medium text-ink-700">Key</span>
              <select name="optionKey" defaultValue={option?.key ?? ""} className={`mt-1 block w-20 ${FIELD}`}
                      aria-label={`Option ${i + 1} key`}>
                <option value="">None</option>
                {voice.MENU_KEYS.map((key) => <option key={key} value={key}>{voice.spokenKey(key)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-ink-700">For</span>
              <input name="optionLabel" defaultValue={option?.label ?? ""} placeholder="Service"
                     aria-label={`Option ${i + 1} is for`} className={`mt-1 block w-40 ${FIELD}`} />
            </label>
            <Destinations name="optionTo" numberName="optionNumber" label="Rings" choices={choices}
                          value={option?.to} allowNone={option ? undefined : "Choose"} />
          </div>
        ))}
      </fieldset>
      <Destinations name="noInputTo" numberName="noInputNumber" choices={choices}
                    label="A caller who presses nothing, after hearing it three times, goes to"
                    value={menu?.noInputTo ?? { kind: "voicemail", box: "main" }} />
      <Destinations name="afterHoursTo" numberName="afterHoursNumber" choices={choices}
                    label="Outside your business hours, calls go to"
                    value={menu?.afterHoursTo ?? null} allowNone="This menu, at every hour" />
      <Select label="Seconds a caller has to press a key" name="timeoutSeconds"
              defaultValue={String(menu?.timeoutSeconds ?? 6)} className="block w-40"
              options={[4, 6, 8, 10, 15].map((n) => ({ value: String(n), label: `${n} seconds` }))} />
    </ActionForm>
  );
}

function RingGroupForm({ group, choices }: { group?: phoneMenus.RingGroupView | undefined; choices: Choices }) {
  const rows = [...(group?.members ?? []), ...Array.from({ length: 3 }, () => null)].slice(0, voice.MAX_RING_MEMBERS);
  return (
    <ActionForm action={saveRingGroup} submit={group ? "Save group" : "Make group"} done="Saved."
                hidden={group ? { id: group.id } : {}} className="mt-3 space-y-4">
      <TextField label="Name" name="name" required defaultValue={group?.name ?? ""} placeholder="Service team" />
      <div className="flex flex-wrap gap-4">
        <Select label="How the phones ring" name="strategy" defaultValue={group?.strategy ?? "all_at_once"}
                options={voice.RING_STRATEGIES.map((s) => ({ value: s, label: voice.RING_STRATEGY[s].label }))} />
        <Select label="Ring each for" name="ringSeconds" defaultValue={String(group?.ringSeconds ?? 20)}
                options={[10, 15, 20, 25, 30, 45].map((n) => ({ value: String(n), label: `${n} seconds` }))} />
      </div>
      <fieldset className="space-y-2 rounded-md border border-steel-200 p-3">
        <legend className="px-1 text-sm font-medium">Who it rings, in order</legend>
        {rows.map((member, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <select name="member" aria-label={`Member ${i + 1}`}
                    defaultValue={member ? (member.userId ?? "number") : ""} className={FIELD}>
              <option value="">Nobody</option>
              {choices.people.map((p) => (
                <option key={p.userId} value={p.userId}>{p.name}{p.phone ? "" : " (no number yet)"}</option>
              ))}
              <option value="number">A number outside the company</option>
            </select>
            <input name="memberNumber" defaultValue={member?.e164 ?? ""} placeholder="Number, if outside"
                   aria-label={`Member ${i + 1} number`} className={`w-40 ${FIELD}`} />
            <input name="memberLabel" defaultValue={member?.e164 ? member.label : ""} placeholder="Called, if outside"
                   aria-label={`Member ${i + 1} name`} className={`w-44 ${FIELD}`} />
          </div>
        ))}
      </fieldset>
      <Destinations name="noAnswerTo" numberName="noAnswerNumber" choices={choices}
                    label="When nobody picks up, the caller goes to"
                    value={group?.noAnswerTo ?? { kind: "voicemail", box: "main" }} />
    </ActionForm>
  );
}

/**
 * PHONE MENUS, RING GROUPS AND WHO ANSWERS
 *
 * What a company sets up so its own number answers like an office: a menu,
 * the groups of phones its options ring, the number each person answers on,
 * and which of the company's numbers the menu answers. Each save is checked
 * against what exists, and the refusal names the option to fix.
 *
 * The forms work with no script: a menu has spare rows to fill in, and a row
 * left empty is ignored. `settings:read` to see it and `settings:write` to
 * change it, the same as how a number rings.
 */
export default async function PhoneMenusPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const ctx = { actor: user.actor, db: getDb() };
  const writes = can(user.actor, "settings:write");

  const [menus, groups, choices, numbers, transcripts] = await Promise.all([
    phoneMenus.listMenus(ctx),
    phoneMenus.listRingGroups(ctx),
    phoneMenus.choices(ctx),
    phoneNumbers.list(ctx),
    transcription.status(ctx),
  ]);
  const people = choices.people;
  const voiceNumbers = numbers.filter((n) => n.purpose === "main" || n.purpose === "tracking" || n.purpose === "user");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Phone menus" count={menus.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Have your number answer like an office: &quot;press 1 for service, 2 for billing&quot;, with each
        option ringing a person, a group of phones, voicemail or another menu. Outside your business
        hours (the hours on your online booking page) calls can go to whoever is on call this week.
      </p>

      <section className="mt-8" aria-labelledby="numbers">
        <h2 id="numbers" className="text-base font-semibold">Your numbers</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          A number on your own Twilio account can be answered here without changing it: only its
          calls are pointed here, and where they went before is kept so you can put them back.
        </p>
        {voiceNumbers.length === 0 ? (
          <Empty title="No numbers yet">Add your main number on the <a href="/settings" className="underline underline-offset-4">Settings</a> page first.</Empty>
        ) : (
          <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200">
            {voiceNumbers.map((n) => (
              <li key={n.id} className="p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium"><Phone value={n.e164} /></span>
                  {n.label ? <span className="text-sm text-ink-500">{n.label}</span> : null}
                  <Chip tone={n.routedHere ? "success" : "neutral"}>{n.routedHere ? "Answered here" : "Not answered here"}</Chip>
                  {n.menuId ? <Chip tone="info">{menus.find((m) => m.id === n.menuId)?.name ?? "A menu"} menu</Chip> : null}
                </div>
                {writes && !n.routedHere ? (
                  <ActionForm action={answerHere} submit="Answer calls here" tone="quiet" hidden={{ id: n.id }} className="mt-2 space-y-2" />
                ) : null}
                {writes && n.routedHere ? (
                  <ActionForm action={setNumberMenu} submit="Save" tone="quiet" done="Saved." hidden={{ id: n.id }}
                              className="mt-2 flex flex-wrap items-end gap-3">
                    <Select label="Answered by" name="menuId" defaultValue={n.menuId ?? ""} className="block"
                            options={[{ value: "", label: "Ringing, as set on the Settings page" },
                              ...menus.map((m) => ({ value: m.id, label: `The ${m.name} menu` }))]} />
                    <label className="flex items-center gap-2 pb-2 text-sm">
                      <input type="checkbox" name="whisper" defaultChecked={n.whisper} />
                      Tell whoever answers what the caller pressed
                    </label>
                  </ActionForm>
                ) : null}
                {writes && n.adopted ? (
                  <ActionForm action={stopAnswering} submit="Stop answering here" tone="danger" hidden={{ id: n.id }} className="mt-2" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="menus">
        <h2 id="menus" className="text-base font-semibold">Menus</h2>
        {menus.length === 0 ? <Empty title="No menus yet">Build one below, then choose it for a number above.</Empty> : null}
        <ul className="mt-3 space-y-4">
          {menus.map((menu) => (
            <li key={menu.id} className="rounded-md border border-steel-200 p-4">
              <h3 className="font-medium">{menu.name}</h3>
              <p className="mt-1 text-sm text-ink-700">
                <span className="text-ink-500">Callers hear: </span>&quot;{menu.prompt}&quot;
              </p>
              {menu.numbers.length > 0 ? (
                <p className="mt-1 text-sm text-ink-500">Answers {menu.numbers.map((n) => n.e164).join(", ")}.</p>
              ) : null}
              {writes ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline underline-offset-4">Change it</summary>
                  <MenuForm menu={menu} choices={choices} />
                  <ActionForm action={deleteMenu} submit="Delete menu" tone="danger" hidden={{ id: menu.id }} className="mt-4" />
                </details>
              ) : null}
            </li>
          ))}
        </ul>
        {writes ? (
          <div className="mt-6 rounded-md border border-steel-200 p-4">
            <h3 className="font-medium">Build a menu</h3>
            <MenuForm choices={choices} />
          </div>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="groups">
        <h2 id="groups" className="text-base font-semibold">Ring groups</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Several phones for one option: all at once, where the first to pick up gets the caller, or
          one after another. Up to {voice.MAX_RING_MEMBERS} phones.
        </p>
        <ul className="mt-3 space-y-4">
          {groups.map((group) => (
            <li key={group.id} className="rounded-md border border-steel-200 p-4">
              <h3 className="font-medium">{group.name}</h3>
              <p className="mt-1 text-sm text-ink-700">
                {voice.RING_STRATEGY[group.strategy].label}, {group.ringSeconds} seconds each:
                {" "}{group.members.map((m) => m.label).join(", ")}.
              </p>
              {writes ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline underline-offset-4">Change it</summary>
                  <RingGroupForm group={group} choices={choices} />
                  <ActionForm action={deleteRingGroup} submit="Delete group" tone="danger" hidden={{ id: group.id }} className="mt-4" />
                </details>
              ) : null}
            </li>
          ))}
        </ul>
        {writes ? (
          <div className="mt-6 rounded-md border border-steel-200 p-4">
            <h3 className="font-medium">Make a ring group</h3>
            <RingGroupForm choices={choices} />
          </div>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="who">
        <h2 id="who" className="text-base font-semibold">Who answers, on which phone</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          The number each person is rung on when a menu, a ring group or the on call rota rings them.
          Who is on call each week is set on <a href="/schedule/crews" className="underline underline-offset-4">Crews and on call</a>.
        </p>
        <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200">
          {people.map((p) => (
            <li key={p.userId} className="flex flex-wrap items-end justify-between gap-2 p-3">
              <span className="text-sm font-medium">{p.name}</span>
              {writes ? (
                <ActionForm action={setAnsweringPhone} submit="Save" tone="quiet" done="Saved."
                            hidden={{ userId: p.userId }} className="flex flex-wrap items-end gap-2">
                  <input name="e164" defaultValue={p.phone ?? ""} placeholder="(512) 555-0147"
                         aria-label={`${p.name}'s number`} className={`w-44 ${FIELD}`} />
                </ActionForm>
              ) : (
                <span className="text-sm text-ink-700">{p.phone ? <Phone value={p.phone} /> : "No number"}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="transcripts">
        <h2 id="transcripts" className="text-base font-semibold">Call transcripts</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {transcripts.connected
            ? "Recordings and voicemails are written out a minute or two after each call, with card numbers removed, and can be searched on the call log."
            : "Not turned on. Connect speech to text under Integrations to have recordings and voicemails written out and searchable."}
          {" "}<a href="/settings/integrations" className="underline underline-offset-4">Integrations</a>
        </p>
      </section>
    </div>
  );
}
