"use client";

import { useState } from "react";
import { automation } from "@opentradesos/core";

/**
 * THE CANVAS
 *
 * What was here before was a list of checkboxes: one of each step kind, in a fixed
 * order, with no way to have two messages and no way to branch. So the engine's
 * `branch` step had no shape anybody could author, and an automation was a straight
 * line even though the thing contractors ask for first is "only if".
 *
 * WHAT THIS IS NOT is a free-form graph editor with draggable boxes and arrows you
 * connect by hand. That is the thing everybody pictures, and the reason the old
 * comment here argued against it was never that it is hard to draw: it is that a
 * free graph can express a cycle and a dangling node, and this engine runs a list
 * that only goes forwards. An editor that can draw what the runner cannot run is
 * an editor whose every save is a possible refusal.
 *
 * So it is a VERTICAL FLOW, which is the shape an automation actually has: the
 * trigger at the top, steps down the page, and a branch opening two lanes that
 * rejoin. Nesting is indentation rather than geometry. Everything drawable here is
 * runnable, and the arithmetic that turns the lanes into the engine's flat list
 * with its arm counts is `flattenPlan` in core, which the server uses too, because
 * two translations of one thing disagree eventually and the one that would be wrong
 * is the one that decides what runs.
 */

export interface StepOption {
  kind: string;
  label: string;
  description: string;
  permissions: string[];
  allowed: boolean;
  /**
   * What a step's fields offer, for a step that picks from the company's own
   * records: the reports and the people a report can be emailed to. Carried on
   * the option rather than threaded through every lane, because it is a fact
   * about the step and not about where it sits.
   */
  choices?: {
    reports: { value: string; label: string }[];
    people: { userId: string; name: string }[];
    periods: { key: string; label: string }[];
  } | undefined;
}

/** A node on the canvas, with an id so React can keep track of a lane. */
interface Node {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  then?: Node[];
  otherwise?: Node[];
}

let counter = 0;
const nextId = () => {
  counter += 1;
  return `n${counter}`;
};

const withIds = (nodes: automation.PlanNode[]): Node[] => nodes.map((node) => ({
  id: nextId(),
  kind: node.kind,
  config: (node.config ?? {}) as Record<string, unknown>,
  ...(node.kind === "branch"
    ? { then: withIds(node.then ?? []), otherwise: withIds(node.otherwise ?? []) }
    : {}),
}));

const asPlan = (nodes: Node[]): automation.PlanNode[] => nodes.map((node) => ({
  kind: node.kind,
  config: node.config,
  ...(node.kind === "branch"
    ? { then: asPlan(node.then ?? []), otherwise: asPlan(node.otherwise ?? []) }
    : {}),
}));

/** The comparators a condition can use, in the words somebody reads them in. */
const COMPARATORS: { value: string; label: string }[] = [
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "is set" },
  { value: "not_exists", label: "is not set" },
];

/** Whether this comparator needs a value beside it. `is set` does not. */
const needsValue = (op: string) => op !== "exists" && op !== "not_exists";

const BUTTON =
  "inline-flex h-7 items-center rounded border border-steel-300 px-2 text-xs hover:bg-steel-100 disabled:opacity-40";

export function Canvas({
  steps, initial, triggerSummary,
}: {
  steps: StepOption[];
  initial?: automation.PlanNode[];
  /** What fires it, drawn at the top so the flow starts somewhere. */
  triggerSummary: string;
}) {
  const [nodes, setNodes] = useState<Node[]>(() =>
    withIds(initial && initial.length > 0 ? initial : [{ kind: "create_task", config: {} }]));

  /**
   * Edit one lane and leave the rest alone.
   *
   * A path of ids rather than indices: an index into a lane is stale the moment
   * anything above it moves, and the move controls are the whole point of the
   * screen.
   */
  const editLane = (
    list: Node[], path: string[], change: (lane: Node[]) => Node[],
  ): Node[] => {
    if (path.length === 0) return change(list);
    const [head, arm, ...rest] = path;
    return list.map((node) => {
      if (node.id !== head) return node;
      const lane = arm === "then" ? node.then ?? [] : node.otherwise ?? [];
      const edited = editLane(lane, rest, change);
      return arm === "then" ? { ...node, then: edited } : { ...node, otherwise: edited };
    });
  };

  const at = (path: string[], change: (lane: Node[]) => Node[]) =>
    setNodes((current) => editLane(current, path, change));

  const add = (path: string[], kind: string) => at(path, (lane) => [
    ...lane,
    {
      id: nextId(),
      kind,
      config: kind === "branch" ? { conditions: { all: [] } } : {},
      ...(kind === "branch" ? { then: [], otherwise: [] } : {}),
    },
  ]);

  const remove = (path: string[], id: string) =>
    at(path, (lane) => lane.filter((node) => node.id !== id));

  const move = (path: string[], id: string, by: -1 | 1) => at(path, (lane) => {
    const index = lane.findIndex((node) => node.id === id);
    const to = index + by;
    if (index < 0 || to < 0 || to >= lane.length) return lane;
    const copy = [...lane];
    const [taken] = copy.splice(index, 1);
    copy.splice(to, 0, taken!);
    return copy;
  });

  const setConfig = (path: string[], id: string, config: Record<string, unknown>) =>
    at(path, (lane) => lane.map((node) => (node.id === id ? { ...node, config } : node)));

  const plan = asPlan(nodes);
  const flat = automation.flattenPlan(plan);
  const problems = automation.checkBranches(flat);

  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink-700">What does it do?</legend>
      <p className="mt-1 max-w-prose text-xs text-ink-500">
        Top to bottom. A step that fails stops the ones after it, because a later step that assumes
        an earlier one happened will do something wrong rather than nothing. An <em>Only if</em>
        {" "}opens two lanes and they rejoin underneath.
      </p>

      {/*
        The posted value. The tree is translated by the same function the server
        uses, so what is drawn and what is saved cannot drift.
      */}
      <input type="hidden" name="plan" value={JSON.stringify(plan)} />

      <div className="mt-4">
        <Start summary={triggerSummary} />
        <Lane
          lane={nodes} path={[]} prefix="" steps={steps}
          add={add} remove={remove} move={move} setConfig={setConfig}
        />
        <End count={flat.length} />
      </div>

      {problems.length > 0 && (
        /*
          Shown while they are still editing rather than only on the refusal. The
          server refuses the same thing with the same sentence, from the same
          function, so this is an earlier copy of the truth and not a second one.
        */
        <ul className="mt-3 space-y-1">
          {problems.map((problem, i) => (
            <li key={i} role="alert" className="text-sm text-red-600">
              {automation.explainBranch(problem)}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function Start({ summary }: { summary: string }) {
  return (
    <div className="flex flex-col items-start">
      <div className="rounded-full border border-blue-600 bg-blue-100/40 px-3 py-1 text-xs font-medium text-blue-600">
        {summary}
      </div>
      <Connector />
    </div>
  );
}

/** The line between two cards. Decoration, so it is hidden from a reader. */
function Connector({ className }: { className?: string }) {
  return <span aria-hidden className={`ml-4 block w-px bg-steel-300 ${className ?? "h-4"}`} />;
}

function End({ count }: { count: number }) {
  return (
    <p className="mt-1 text-xs text-ink-500">
      {/*
        The number the engine will see, not the number of cards. A branch with two
        arms is four steps and three cards, and somebody debugging a run against
        this screen needs the engine's count to line up with the run's rows.
      */}
      {count === 1 ? "One step" : `${count} steps`} when this runs.
    </p>
  );
}

function Lane({
  lane, path, prefix, steps, add, remove, move, setConfig,
}: {
  lane: Node[];
  path: string[];
  /**
   * Where this lane sits, in words, so each card can be named.
   *
   * Two task cards on one canvas have two boxes whose only label is "Title", which
   * a screen reader reads as two identical fields and a browser test cannot tell
   * apart either. Naming the card is the fix a reader actually benefits from: the
   * announcement becomes "Then, step 1, Raise a task, Title".
   */
  prefix: string;
  steps: StepOption[];
  add: (path: string[], kind: string) => void;
  remove: (path: string[], id: string) => void;
  move: (path: string[], id: string, by: -1 | 1) => void;
  setConfig: (path: string[], id: string, config: Record<string, unknown>) => void;
}) {
  return (
    <div>
      {lane.map((node, index) => (
        <div key={node.id}>
          <Card
            node={node} path={path} steps={steps}
            name={`${prefix}step ${index + 1}`}
            first={index === 0} last={index === lane.length - 1}
            add={add} remove={remove} move={move} setConfig={setConfig}
          />
          <Connector />
        </div>
      ))}
      <AddStep
        steps={steps}
        where={prefix === "" ? "the end" : prefix.replace(/, $/, "")}
        onAdd={(kind) => add(path, kind)}
      />
    </div>
  );
}

function Card({
  node, path, steps, name, first, last, add, remove, move, setConfig,
}: {
  node: Node;
  path: string[];
  steps: StepOption[];
  /** Where it sits, so its fields and its controls are distinguishable. */
  name: string;
  first: boolean;
  last: boolean;
  add: (path: string[], kind: string) => void;
  remove: (path: string[], id: string) => void;
  move: (path: string[], id: string, by: -1 | 1) => void;
  setConfig: (path: string[], id: string, config: Record<string, unknown>) => void;
}) {
  const option = steps.find((s) => s.kind === node.kind);
  const set = (config: Record<string, unknown>) => setConfig(path, node.id, config);

  const titled = `${name}, ${option?.label ?? node.kind}`;

  return (
    <section aria-label={titled} className="rounded-md border border-steel-200 bg-canvas p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink-900">{option?.label ?? node.kind}</p>
          <p className="text-xs text-ink-500">{option?.description ?? ""}</p>
          {option && !option.allowed && (
            <p className="mt-1 text-xs text-ink-500">
              You do not hold {option.permissions.join(", ")}, so you cannot publish an automation
              that does this.
            </p>
          )}
        </div>
        <div className="flex gap-1">
          <button type="button" className={BUTTON} disabled={first}
                  onClick={() => move(path, node.id, -1)}
                  aria-label={`Move ${titled} up`}>
            Up
          </button>
          <button type="button" className={BUTTON} disabled={last}
                  onClick={() => move(path, node.id, 1)}
                  aria-label={`Move ${titled} down`}>
            Down
          </button>
          <button type="button" className={BUTTON}
                  onClick={() => remove(path, node.id)}
                  aria-label={`Remove ${titled}`}>
            Remove
          </button>
        </div>
      </div>

      {node.kind === "send_message" && <MessageFields config={node.config} set={set} />}
      {node.kind === "text_caller" && <CallerFields config={node.config} set={set} />}
      {node.kind === "create_task" && <TaskFields config={node.config} set={set} />}
      {node.kind === "wait" && <WaitFields config={node.config} set={set} />}
      {node.kind === "email_report" && (
        <ReportFields config={node.config} set={set} choices={option?.choices} name={titled} />
      )}
      {node.kind === "stop_unless" && <CheckFields config={node.config} set={set} />}
      {(node.kind === "send_estimate" || node.kind === "send_review_request") && (
        <LinkMessageFields
          config={node.config} set={set}
          placeholder={node.kind === "send_estimate"
            ? "Hi {{ customer.name }}, just checking you saw estimate #{{ estimate.number }}: {{ link }}"
            : "Hi {{ customer.name }}, would you leave us a review? {{ review.url }}"}
          note={node.kind === "send_estimate"
            ? "Has to include {{ link }}, which becomes a fresh link to the estimate. Sent only while it is still waiting for an answer."
            : "{{ review.url }} is the link to the review site the request names. Sent only if your review rules queued a request."}
        />
      )}
      {node.kind === "request_review" && <PlatformFields config={node.config} set={set} />}

      {node.kind === "branch" && (
        <div className="mt-3">
          <BranchFields config={node.config} set={set} />
          <Arm
            label="Then" lane={node.then ?? []} path={[...path, node.id, "then"]}
            prefix={`${name}, then, `}
            steps={steps} add={add} remove={remove} move={move} setConfig={setConfig}
          />
          <Arm
            label="Otherwise" lane={node.otherwise ?? []} path={[...path, node.id, "otherwise"]}
            prefix={`${name}, otherwise, `}
            steps={steps} add={add} remove={remove} move={move} setConfig={setConfig}
            note="Leave this empty for an automation that only acts when the condition holds."
          />
        </div>
      )}
    </section>
  );
}

function Arm({
  label, note, lane, path, prefix, steps, add, remove, move, setConfig,
}: {
  label: string;
  note?: string;
  lane: Node[];
  path: string[];
  prefix: string;
  steps: StepOption[];
  add: (path: string[], kind: string) => void;
  remove: (path: string[], id: string) => void;
  move: (path: string[], id: string, by: -1 | 1) => void;
  setConfig: (path: string[], id: string, config: Record<string, unknown>) => void;
}) {
  return (
    <div className="mt-3 border-l-2 border-steel-300 pl-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      {note && lane.length === 0 ? <p className="mt-0.5 text-xs text-ink-500">{note}</p> : null}
      <div className="mt-2">
        <Lane
          lane={lane} path={path} prefix={prefix} steps={steps}
          add={add} remove={remove} move={move} setConfig={setConfig}
        />
      </div>
    </div>
  );
}

function AddStep({
  steps, where, onAdd,
}: { steps: StepOption[]; where: string; onAdd: (kind: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {open ? (
        <div className="flex flex-wrap gap-2 rounded-md border border-dashed border-steel-300 p-2">
          {steps.map((step) => (
            <button
              key={step.kind} type="button" className={BUTTON}
              /*
                "Add Raise a task" rather than "Raise a task". The visible word is
                the step, which is what somebody scanning a row of them wants, and
                the accessible name says what pressing it does. It also stops the
                name colliding with "Move Raise a task up" on a card above, which
                is three buttons a reader would otherwise have to tell apart by
                position.
              */
              aria-label={`Add ${step.label}`}
              onClick={() => { onAdd(step.kind); setOpen(false); }}
            >
              {step.label}
            </button>
          ))}
          <button type="button" className={BUTTON} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}
                /*
                  Three lanes on one canvas have three buttons reading "Add a step".
                  The visible words stay short and the accessible name says which lane,
                  which is the difference between a reader knowing where they are and
                  counting buttons.
                */
                aria-label={`Add a step to ${where}`}
                className="inline-flex h-7 items-center rounded border border-dashed border-steel-300 px-2 text-xs text-ink-700 hover:bg-steel-100">
          Add a step
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- step fields */

const FIELD = "mt-1 h-9 rounded border border-steel-300 px-2 text-sm";

function MessageFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  const channel = config["channel"] === "email" ? "email" : "sms";
  /** Always transactional: a promotion by email needs an unsubscribe link, and goes as a campaign. */
  const change = (next: Record<string, unknown>) => set({ ...config, purpose: "transactional", channel, ...next });
  return (
    <div className="mt-3 space-y-2 text-sm">
      <label className="block">
        <span className="block text-ink-700">How</span>
        <select value={channel} onChange={(e) => change({ channel: e.target.value })} className={`${FIELD} w-40`}>
          <option value="sms">By text</option>
          <option value="email">By email</option>
        </select>
      </label>
      {channel === "email" && (
        <label className="block">
          <span className="block text-ink-700">Subject</span>
          <input
            value={String(config["subject"] ?? "")}
            onChange={(e) => change({ subject: e.target.value })}
            placeholder="A message from {{ organization.name }}"
            className={`${FIELD} w-full`}
          />
        </label>
      )}
      <label className="block">
        <span className="block text-ink-700">What it says</span>
        <textarea
          rows={channel === "email" ? 4 : 2}
          value={String(config["body"] ?? "")}
          onChange={(e) => change({ body: e.target.value })}
          placeholder="Hi {{ customer.name }}, just checking on the quote we sent."
          className="mt-1 w-full rounded border border-steel-300 p-2 text-sm"
        />
      </label>
      <span className="block text-xs text-ink-500">
        Placeholders are filled from the event. Nothing is evaluated: it is substitution and no
        more. {channel === "email"
          ? "Sent from your email address. Somebody on your do not email list is not sent it."
          : "Consent is checked when the message is sent, not now."}
      </span>
    </div>
  );
}

/** The text back after a missed call: only the words, because the number is the caller's. */
function CallerFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  return (
    <label className="mt-3 block text-sm">
      <span className="block text-ink-700">What it says</span>
      <textarea
        rows={2}
        value={String(config["body"] ?? "")}
        onChange={(e) => set({ ...config, body: e.target.value })}
        placeholder="Hi, this is {{ organization.name }}. Sorry we missed your call."
        className="mt-1 w-full rounded border border-steel-300 p-2 text-sm"
      />
      <span className="mt-1 block text-xs text-ink-500">
        Sent to the number that rang, from your main texting number. Somebody who replied STOP is not texted.
      </span>
    </label>
  );
}

function TaskFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-sm">
      <label>
        <span className="block text-ink-700">Title</span>
        <input
          value={String(config["title"] ?? "")}
          onChange={(e) => set({ ...config, title: e.target.value })}
          placeholder="Chase this estimate" className={`${FIELD} w-64`}
        />
      </label>
      <label>
        <span className="block text-ink-700">Queue</span>
        <input
          value={String(config["queue"] ?? "")}
          onChange={(e) => set({ ...config, queue: e.target.value })}
          placeholder="office" className={`${FIELD} w-32`}
        />
      </label>
      <label>
        <span className="block text-ink-700">Due in hours</span>
        <input
          type="number" min="0"
          value={String(config["dueInHours"] ?? "")}
          onChange={(e) => set({ ...config, dueInHours: e.target.value })}
          className={`${FIELD} w-28`}
        />
      </label>
    </div>
  );
}

function WaitFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
      <label>
        <span className="block text-ink-700">Days</span>
        <input
          type="number" min="0" value={String(config["days"] ?? "3")}
          onChange={(e) => set({ ...config, days: e.target.value })}
          className={`${FIELD} w-24`}
        />
      </label>
      <label>
        <span className="block text-ink-700">Hours</span>
        <input
          type="number" min="0" value={String(config["hours"] ?? "0")}
          onChange={(e) => set({ ...config, hours: e.target.value })}
          className={`${FIELD} w-24`}
        />
      </label>
      <p className="pb-2 text-xs text-ink-500">Stored on the run, so it survives a restart.</p>
    </div>
  );
}

/**
 * Which report, to whom, over which days.
 *
 * The people are everybody in the company, ticked; anybody who could not open
 * the report themselves is refused by name when the automation is saved,
 * rather than missing from this list with no explanation. Outside addresses
 * are one box. The report runs as whoever publishes the automation.
 */
function ReportFields({
  config, set, choices, name,
}: {
  config: Record<string, unknown>;
  set: (c: Record<string, unknown>) => void;
  choices: StepOption["choices"];
  name: string;
}) {
  const reports = choices?.reports ?? [];
  const people = choices?.people ?? [];
  const toCustomer = config["to"] === "customer";
  const ticked = Array.isArray(config["userIds"]) ? (config["userIds"] as string[]) : [];
  const addresses = Array.isArray(config["addresses"])
    ? (config["addresses"] as string[]).join(", ")
    : String(config["addresses"] ?? "");
  return (
    <div className="mt-3 space-y-3 text-sm">
      <div className="flex flex-wrap gap-3">
        <label>
          <span className="block text-ink-700">Report</span>
          <select
            value={String(config["report"] ?? "")}
            onChange={(e) => set({ ...config, report: e.target.value })}
            aria-label={`${name}, report`}
            className={`${FIELD} w-64`}
          >
            <option value="">Pick a report</option>
            {reports.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <label>
          <span className="block text-ink-700">Which days it covers</span>
          <select
            value={String(config["period"] ?? "all")}
            onChange={(e) => set({ ...config, period: e.target.value })}
            aria-label={`${name}, which days it covers`}
            className={`${FIELD} w-56`}
          >
            {(choices?.periods ?? []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <fieldset>
        <legend className="text-ink-700">Who gets it</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" name={`${name}, who gets it`} checked={!toCustomer}
                   onChange={() => set({ ...config, to: "people" })} />
            People you pick
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" name={`${name}, who gets it`} checked={toCustomer}
                   onChange={() => set({ ...config, to: "customer", userIds: [], addresses: [] })} />
            The customer this is about
          </label>
        </div>
      </fieldset>
      {toCustomer ? (
        <p className="text-xs text-ink-500">
          {/*
            Said before the save rather than discovered at it: what the save refuses,
            in the words somebody choosing a report needs.
          */}
          Sent to the email address on their record, with only their own jobs, invoices, estimates or visits in it.
          A report with your costs, margins or your own fields in it cannot be sent to a customer, and neither can
          one on an automation that runs on a clock.
        </p>
      ) : (
      <>
      <fieldset>
        <legend className="text-ink-700">Email it to</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {people.map((person) => (
            <label key={person.userId} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={ticked.includes(person.userId)}
                onChange={(e) => set({
                  ...config,
                  userIds: e.target.checked
                    ? [...ticked, person.userId]
                    : ticked.filter((id) => id !== person.userId),
                })}
              />
              {person.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="block text-ink-700">And outside the company</span>
        <input
          value={addresses}
          onChange={(e) => set({ ...config, addresses: e.target.value })}
          placeholder="books@youraccountant.com"
          aria-label={`${name}, outside addresses`}
          className={`${FIELD} w-80`}
        />
      </label>
      </>
      )}
      <p className="text-xs text-ink-500">
        It runs as whoever publishes this automation, with what they can see, and goes with a spreadsheet of
        every row. Each run sends it once.
      </p>
    </div>
  );
}

/**
 * Which fact to look at again. A list from the engine's own catalogue, so
 * there is no way to type a question this build cannot ask.
 */
function CheckFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  const checks = Object.entries(automation.CHECKS);
  return (
    <label className="mt-3 block text-sm">
      <span className="block text-ink-700">Carry on only while</span>
      <select
        value={String(config["check"] ?? checks[0]?.[0] ?? "")}
        onChange={(e) => set({ ...config, check: e.target.value })}
        className={`${FIELD} w-full`}
      >
        {checks.map(([key, check]) => <option key={key} value={key}>{check.label}</option>)}
      </select>
    </label>
  );
}

/** A message that carries a link: by text or by email, with a subject for an email. */
function LinkMessageFields({
  config, set, placeholder, note,
}: {
  config: Record<string, unknown>;
  set: (c: Record<string, unknown>) => void;
  placeholder: string;
  note: string;
}) {
  const channel = config["channel"] === "email" ? "email" : "sms";
  return (
    <div className="mt-3 space-y-2 text-sm">
      <label className="block">
        <span className="block text-ink-700">How</span>
        <select
          value={channel}
          onChange={(e) => set({ ...config, channel: e.target.value })}
          className={`${FIELD} w-40`}
        >
          <option value="sms">By text</option>
          <option value="email">By email</option>
        </select>
      </label>
      {channel === "email" && (
        <label className="block">
          <span className="block text-ink-700">Subject</span>
          <input
            value={String(config["subject"] ?? "")}
            onChange={(e) => set({ ...config, subject: e.target.value })}
            className={`${FIELD} w-full`}
          />
        </label>
      )}
      <label className="block">
        <span className="block text-ink-700">What it says</span>
        <textarea
          rows={3}
          value={String(config["body"] ?? "")}
          onChange={(e) => set({ ...config, body: e.target.value })}
          placeholder={placeholder}
          className="mt-1 w-full rounded border border-steel-300 p-2 text-sm"
        />
      </label>
      <p className="text-xs text-ink-500">{note} Consent is checked when it is sent, not now.</p>
    </div>
  );
}

/** Which review site the ask points at, by the key it was declared under. */
function PlatformFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  return (
    <label className="mt-3 block text-sm">
      <span className="block text-ink-700">Review site</span>
      <input
        value={String(config["platform"] ?? "")}
        onChange={(e) => set({ ...config, platform: e.target.value })}
        placeholder="google"
        className={`${FIELD} w-48`}
      />
      <span className="mt-1 block text-xs text-ink-500">
        The key you declared it under on the reviews screen. Your review rules decide whether and when to ask.
      </span>
    </label>
  );
}

/**
 * THE CONDITION ON A BRANCH, AS THREE GROUPS
 *
 * The engine has always evaluated three lists: every condition in `all` has
 * to hold, at least one in `any`, and none in `none`. The canvas offered only
 * the first, because three lists drawn as one list of rows leaves nobody able
 * to tell which group a row belongs to, and a row in the wrong group inverts
 * what the automation does without looking any different.
 *
 * So each group is its own box with its rule as its heading, its own rows and
 * its own add button, and the sentence underneath reads the whole thing back
 * the way the engine will take it. Three lists and never deeper, because that
 * is what the engine runs: a group inside a group would be a picture of
 * something nothing evaluates.
 *
 * Keyboard first: every control is a native field or button in reading order,
 * each is named for its group and row, and adding a row puts the cursor in it.
 */
type GroupKey = "all" | "any" | "none";
type ConditionRow = { path: string; op: string; value?: unknown };

const GROUPS: { key: GroupKey; heading: string; word: string; empty: string }[] = [
  { key: "all", heading: "All of these have to hold", word: "", empty: "" },
  {
    key: "any", heading: "At least one of these has to hold", word: "at least one of, ",
    empty: "Add two or more ways it can be true, and one is enough.",
  },
  {
    key: "none", heading: "None of these may hold", word: "none of, ",
    empty: "Anything here stops it taking the first lane.",
  },
];

/** One condition in words, for the sentence that reads the group back. */
const describeCondition = (c: ConditionRow) => {
  const op = COMPARATORS.find((x) => x.value === c.op)?.label ?? c.op;
  const path = c.path.trim() === "" ? "(nothing chosen)" : c.path.trim();
  return needsValue(c.op) ? `${path} ${op} ${String(c.value ?? "") || "(blank)"}` : `${path} ${op}`;
};

/** The whole branch condition as the engine will read it, in one sentence. */
function describeConditions(group: Partial<Record<GroupKey, ConditionRow[]>>): string {
  const parts: string[] = [];
  const all = group.all ?? [];
  const any = group.any ?? [];
  const none = group.none ?? [];
  if (all.length > 0) parts.push(all.map(describeCondition).join(" and "));
  if (any.length > 0) parts.push(`at least one of: ${any.map(describeCondition).join(" or ")}`);
  if (none.length > 0) parts.push(`none of: ${none.map(describeCondition).join(", ")}`);
  if (parts.length === 0) return "Nothing to check yet, so this would always take the first lane.";
  return `Takes the first lane when ${parts.join(", and ")}. Otherwise it takes the second.`;
}

function BranchFields({
  config, set,
}: { config: Record<string, unknown>; set: (c: Record<string, unknown>) => void }) {
  const stored = (config["conditions"] ?? {}) as Partial<Record<GroupKey, ConditionRow[]>>;
  const lists: Record<GroupKey, ConditionRow[]> = {
    all: stored.all ?? [], any: stored.any ?? [], none: stored.none ?? [],
  };
  /** Which groups are drawn: `all` always, the others once they are added or hold something. */
  const [shown, setShown] = useState<GroupKey[]>(() =>
    (["all", "any", "none"] as GroupKey[]).filter((key) => key === "all" || lists[key].length > 0));
  /** The row just added, so the cursor goes to it. */
  const [fresh, setFresh] = useState<{ group: GroupKey; index: number } | null>(null);

  const write = (key: GroupKey, next: ConditionRow[]) => {
    const conditions: Partial<Record<GroupKey, ConditionRow[]>> = {};
    for (const g of ["all", "any", "none"] as GroupKey[]) {
      const rows = g === key ? next : lists[g];
      if (rows.length > 0 || g === "all") conditions[g] = rows;
    }
    set({ ...config, conditions });
  };

  const addRow = (key: GroupKey) => {
    setFresh({ group: key, index: lists[key].length });
    write(key, [...lists[key], { path: "", op: "eq", value: "" }]);
  };

  const addGroup = (key: GroupKey) => {
    setShown((current) => (current.includes(key) ? current : [...current, key]));
    addRow(key);
  };

  const removeGroup = (key: GroupKey) => {
    setShown((current) => current.filter((g) => g !== key));
    write(key, []);
  };

  return (
    <div className="space-y-2">
      {GROUPS.filter((group) => shown.includes(group.key)).map((group) => {
        const rows = lists[group.key];
        const named = (part: string, index: number) => `${part}, ${group.word}condition ${index + 1}`;
        return (
          <fieldset key={group.key} className="rounded border border-steel-200 bg-canvas-raised p-2">
            <legend className="px-1 text-xs font-medium text-ink-700">{group.heading}</legend>
            {rows.length === 0 && group.empty !== "" && (
              <p className="mt-1 text-xs text-ink-500">{group.empty}</p>
            )}
            <div className="mt-2 space-y-2">
              {rows.map((condition, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    value={condition.path}
                    onChange={(e) => write(group.key, rows.map((c, i) => (i === index ? { ...c, path: e.target.value } : c)))}
                    placeholder="invoice.total"
                    list="condition-paths"
                    aria-label={named("What to check", index)}
                    autoFocus={fresh?.group === group.key && fresh.index === index}
                    className="h-8 w-48 rounded border border-steel-300 px-2 font-mono text-xs"
                  />
                  <select
                    value={condition.op}
                    onChange={(e) => write(group.key, rows.map((c, i) => (i === index ? { ...c, op: e.target.value } : c)))}
                    aria-label={named("How to compare", index)}
                    className="h-8 rounded border border-steel-300 px-2 text-sm"
                  >
                    {COMPARATORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {needsValue(condition.op) && (
                    <input
                      value={String(condition.value ?? "")}
                      onChange={(e) => write(group.key, rows.map((c, i) => (i === index ? { ...c, value: e.target.value } : c)))}
                      placeholder="1000"
                      aria-label={named("What to compare against", index)}
                      className="h-8 w-32 rounded border border-steel-300 px-2 text-sm"
                    />
                  )}
                  <button type="button" className={BUTTON}
                          onClick={() => write(group.key, rows.filter((_, i) => i !== index))}
                          aria-label={`Remove ${group.word}condition ${index + 1}`}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={BUTTON} onClick={() => addRow(group.key)}
                      aria-label={group.key === "all" ? "Add a condition" : `Add a condition to ${group.word.replace(/, $/, "")}`}>
                Add a condition
              </button>
              {group.key !== "all" && (
                <button type="button" className={BUTTON} onClick={() => removeGroup(group.key)}
                        aria-label={`Remove the ${group.heading.toLowerCase()} group`}>
                  Remove this group
                </button>
              )}
            </div>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap gap-2">
        {!shown.includes("any") && (
          <button type="button" className={BUTTON} onClick={() => addGroup("any")}>
            Add an &quot;at least one of&quot; group
          </button>
        )}
        {!shown.includes("none") && (
          <button type="button" className={BUTTON} onClick={() => addGroup("none")}>
            Add a &quot;none of&quot; group
          </button>
        )}
      </div>

      {/*
        A branch with no conditions is always true, which means the otherwise arm
        can never run. The sentence says so rather than the save refusing it,
        because somebody mid-edit has not finished yet.

        The whole condition read back as one sentence, updated as it changes, so
        somebody who cannot see the boxes side by side still hears which rule each
        row is under.
      */}
      <p aria-live="polite" className="text-xs text-ink-700">{describeConditions(lists)}</p>

      <p className="text-xs text-ink-500">
        A path into the event, like <span className="font-mono">invoice.total</span>,
        {" "}<span className="font-mono">job.status</span>, or for one of your own records
        {" "}<span className="font-mono">record.type</span> and <span className="font-mono">record.fields.status</span>. Comparisons are on the values the event
        carried, so nothing here reads the database and a branch cannot change its mind on a resume.
      </p>
    </div>
  );
}
