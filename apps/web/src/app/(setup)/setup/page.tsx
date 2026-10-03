import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { setup } from "@opentradesos/api/services";
import { packById } from "@opentradesos/trade-packs";
import { Chip } from "@opentradesos/ui";
import { Logo } from "@/components/Logo";
import { stepLink } from "./steps";
import { completeSetup } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE SETUP LIST
 *
 * Ten steps, in the order that makes each easier than the last, with what is
 * done remembered (`setup_step`) and what is already in place read from the
 * data beside each one. "Carry on" goes to the first step still outstanding
 * that this person can do, so somebody who closed the tab at step four comes
 * back to step five.
 *
 * Open after setup is finished too. It used to send anybody back to the app
 * once the company had skipped it, which made "you can come back to this"
 * untrue on the very page that said it.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ applied?: string }> }) {
  const user = await requireUser();
  const { applied } = await searchParams;

  if (!can(user.actor, "settings:read")) {
    return (
      <Frame>
        <h1 className="mt-10 text-2xl font-semibold">{user.organizationName} is still being set up</h1>
        <p className="mt-3 max-w-prose text-ink-700">
          Whoever runs the company is finishing the setup. You will be able to get in once they have.
        </p>
      </Frame>
    );
  }

  const view = await setup.view({ actor: user.actor, db: getDb() });
  const { progress } = view;
  const finished = view.setupCompletedAt !== null;
  const pack = applied ? packById(applied) : undefined;

  return (
    <Frame>
      <h1 className="mt-10 text-2xl font-semibold">Set up {view.companyName}</h1>
      <p className="mt-3 max-w-prose text-ink-700">
        Ten steps. Every one of them can be skipped and finished later, and the ones that matter for
        taking a booking are marked. Most companies are booking work before they finish this list.
      </p>

      {pack ? (
        <p role="status" className="mt-4 rounded border border-green-700 bg-green-tint px-3 py-2 text-sm text-green-700">
          The {pack.name} pack is loaded: a starting price book, job types and checklists.
        </p>
      ) : null}

      <div className="mt-8 rounded-md border border-steel-200 bg-canvas p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {progress.essentialDone} of {progress.essentialTotal} essentials done
          </span>
          <span className="text-ink-500 tnum">{progress.done} of {progress.total} total</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-steel-200"
             role="progressbar" aria-label="Essential steps done"
             aria-valuemin={0} aria-valuemax={progress.essentialTotal} aria-valuenow={progress.essentialDone}>
          <div
            className="h-full rounded-full bg-blue-600 transition-all"
            style={{ width: `${(progress.essentialDone / progress.essentialTotal) * 100}%` }}
          />
        </div>
        {progress.next ? (
          <a href={stepLink(progress.next).href}
             className="mt-4 inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-700">
            {progress.done === 0 ? "Start with " : "Carry on: "}{stepLink(progress.next).title}
          </a>
        ) : progress.complete ? (
          <p className="mt-4 text-sm font-medium text-green-700">Every step is done.</p>
        ) : (
          <p className="mt-4 text-sm text-ink-700">
            Everything you can do is done. The rest needs somebody who holds the permission for it.
          </p>
        )}
      </div>

      <ol className="mt-8 overflow-hidden rounded-md border border-steel-200 bg-canvas">
        {view.steps.map((state, i) => {
          const step = stepLink(state.key);
          return (
            <li key={state.key} className={i > 0 ? "border-t border-steel-200" : ""}>
              <a
                href={state.allowed ? step.href : undefined}
                aria-disabled={!state.allowed}
                className={`flex items-start gap-4 px-5 py-4 transition-colors ${
                  state.allowed ? "hover:bg-steel-100" : "cursor-not-allowed opacity-60"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tnum ${
                    state.done ? "bg-green-700 text-white" : "bg-steel-100 text-ink-500"
                  }`}
                  aria-label={state.done ? "Done" : `Step ${i + 1}`}
                >
                  {state.done ? "✓" : i + 1}
                </span>
                <span className="flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{state.title}</span>
                    {state.essential && <Chip tone="info">Needed to book</Chip>}
                    {state.hasLeadTime && <Chip tone="warning">Start early</Chip>}
                    {state.done && <Chip tone="success">Done</Chip>}
                  </span>
                  <span className="mt-1 block text-sm text-ink-700">{state.summary}</span>
                  {state.facts.length > 0 ? (
                    <span className="mt-1 block text-sm text-ink-500">{state.facts.join(" ")}</span>
                  ) : null}
                  {state.hasLeadTime && !state.done && (
                    <span className="mt-1.5 block text-sm text-ink-500">
                      Someone else has to review this, so it does not finish the day you start it.
                    </span>
                  )}
                  {!state.allowed && (
                    <span className="mt-1.5 block text-sm text-ink-500">Somebody else in the company has to do this one.</span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ol>

      {finished ? (
        <a href="/" className="mt-8 inline-flex h-12 items-center rounded border border-steel-300 bg-canvas px-5 text-base font-medium text-ink-700 hover:bg-steel-100">
          Back to the app
        </a>
      ) : can(user.actor, "settings:write") ? (
        <form action={completeSetup} className="mt-8 flex flex-wrap items-center gap-4">
          <button
            type="submit"
            className="inline-flex h-12 items-center rounded border border-steel-300 bg-canvas px-5 text-base font-medium text-ink-700 transition-colors hover:bg-steel-100"
          >
            {progress.complete ? "Go to the app" : "Skip for now and go to the app"}
          </button>
          <p className="text-sm text-ink-500">
            This list stays here. Settings has a link back to it.
          </p>
        </form>
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas-raised">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
        </div>
        {children}
      </div>
    </div>
  );
}
