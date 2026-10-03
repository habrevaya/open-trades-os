import { redirect } from "next/navigation";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { setup } from "@opentradesos/api/services";
import { can, setup as rules, type Permission } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Logo } from "@/components/Logo";
import { formatIn } from "@/lib/dates";
import { stepLink } from "./steps";
import { markStep } from "./actions";

/**
 * ONE STEP OF THE WIZARD
 *
 * The same frame around every step: where it sits in the ten, what is already
 * in place (read from the data, not remembered), the step's real settings
 * form in the middle, and at the bottom the person's own call on whether it
 * is done. "Skip for now" goes on without marking anything, because a step
 * left for later is not a step done.
 *
 * Outside the app shell on purpose, like the list: a company in its first
 * hour has nothing in the rail worth clicking, and the way back is the list.
 */
export async function loadStep(key: rules.SetupStepKey): Promise<{ user: CurrentUser; allowed: boolean }> {
  const user = await requireUser();
  if (!can(user.actor, "settings:read")) redirect("/setup");
  const step = stepLink(key);
  return { user, allowed: can(user.actor, step.permission as Permission) };
}

export async function StepFrame({
  stepKey, user, allowed, children, intro,
}: {
  stepKey: rules.SetupStepKey;
  user: CurrentUser;
  allowed: boolean;
  children: React.ReactNode;
  /** A sentence or two above the form, in the step's own words. */
  intro?: React.ReactNode;
}) {
  const step = stepLink(stepKey);
  const view = await setup.view({ actor: user.actor, db: getDb() });
  const state = view.steps.find((s) => s.key === stepKey)!;
  const next = rules.stepAfter(stepKey);

  return (
    <div className="min-h-screen bg-canvas-raised">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <a href="/setup" className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
        </a>

        <p className="mt-8 flex flex-wrap items-center gap-2 text-sm text-ink-500">
          <a href="/setup" className="underline underline-offset-4">Setup</a>
          <span>Step {rules.stepNumber(stepKey)} of {rules.SETUP_STEPS.length}</span>
          {step.essential ? <Chip tone="info">Needed to book</Chip> : null}
          {step.hasLeadTime ? <Chip tone="warning">Start early</Chip> : null}
          {state.done ? <Chip tone="success">Done</Chip> : null}
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{step.title}</h1>
        <p className="mt-2 max-w-prose text-ink-700">{step.summary}</p>
        {intro ? <div className="mt-2 max-w-prose text-sm text-ink-700">{intro}</div> : null}

        {state.facts.length > 0 ? (
          <section aria-label="Already in place" className="mt-5 rounded-md border border-steel-200 bg-canvas px-4 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-500">Already in place</h2>
            <ul className="mt-1.5 space-y-0.5 text-sm text-ink-700">
              {state.facts.map((fact) => <li key={fact}>{fact}</li>)}
            </ul>
          </section>
        ) : null}

        <div className="mt-6 rounded-md border border-steel-200 bg-canvas p-5">
          {allowed ? children : (
            <p className="text-sm text-ink-700">
              This step needs a permission you do not hold, so somebody else in the company has to do it.
              You can see it here so you know it is waiting on them.
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {allowed && !state.done ? (
            <form action={markStep}>
              <input type="hidden" name="key" value={stepKey} />
              <button type="submit"
                      className="inline-flex h-12 items-center rounded bg-ink-900 px-5 text-base font-medium text-white hover:bg-ink-700">
                {next ? "This step is done, next step" : "This step is done, back to the list"}
              </button>
            </form>
          ) : null}
          {allowed && state.done ? (
            <form action={markStep} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="key" value={stepKey} />
              <input type="hidden" name="done" value="false" />
              <span className="text-sm text-ink-700">
                Marked done {state.doneAt ? formatIn(new Date(state.doneAt), user.organizationTimezone) : ""}.
              </span>
              <button type="submit"
                      className="inline-flex h-10 items-center rounded border border-steel-300 bg-canvas px-3.5 text-sm font-medium text-ink-700 hover:bg-steel-100">
                Not done after all
              </button>
            </form>
          ) : null}
          <a href={next ? stepLink(next).href : "/setup"}
             className="inline-flex h-10 items-center rounded border border-steel-300 bg-canvas px-3.5 text-sm font-medium text-ink-700 hover:bg-steel-100">
            {state.done ? (next ? "Next step" : "Back to the list") : "Skip for now"}
          </a>
          <a href="/setup" className="text-sm text-ink-700 underline underline-offset-4">Back to the list</a>
        </div>
        <p className="mt-4 text-sm text-ink-500">
          After setup, this is on <a href={step.later.href} className="underline underline-offset-4">{step.later.label}</a>.
        </p>
      </div>
    </div>
  );
}
