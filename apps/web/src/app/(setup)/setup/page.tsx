import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { can, type Permission } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { SETUP_STEPS, essentialSteps } from "./steps";
import { Logo } from "@/components/Logo";
import { completeSetup } from "./actions";

export default async function SetupPage() {
  const user = await requireUser();
  if (user.setupCompleted) redirect("/");

  // Nothing is stored as complete yet, so everything reads as outstanding.
  // Each step marks itself done as it is built out.
  const completed = new Set<string>();
  const essentialDone = essentialSteps.filter((s) => completed.has(s.key)).length;

  return (
    <div className="min-h-screen bg-canvas-raised">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
        </div>

        <h1 className="mt-10 text-2xl font-semibold">Set up {user.organizationName}</h1>
        <p className="mt-3 max-w-prose text-ink-700">
          Ten steps. Every one of them can be skipped and finished later, and the
          ones that matter for taking a booking are marked. Most companies are
          booking work before they finish this list.
        </p>

        <div className="mt-8 rounded-md border border-steel-200 bg-canvas p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {essentialDone} of {essentialSteps.length} essentials done
            </span>
            <span className="text-ink-500 tnum">
              {completed.size} of {SETUP_STEPS.length} total
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-steel-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all"
              style={{ width: `${(essentialDone / essentialSteps.length) * 100}%` }}
            />
          </div>
        </div>

        <ol className="mt-8 overflow-hidden rounded-md border border-steel-200 bg-canvas">
          {SETUP_STEPS.map((step, i) => {
            const allowed = can(user.actor, step.permission as Permission);
            const done = completed.has(step.key);
            return (
              <li key={step.key} className={i > 0 ? "border-t border-steel-200" : ""}>
                <a
                  href={allowed ? `/setup/${step.key}` : undefined}
                  aria-disabled={!allowed}
                  className={`flex items-start gap-4 px-5 py-4 transition-colors ${
                    allowed ? "hover:bg-steel-100" : "cursor-not-allowed opacity-60"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tnum ${
                      done ? "bg-green-700 text-white" : "bg-steel-100 text-ink-500"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <span className="flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{step.title}</span>
                      {step.essential && <Chip tone="info">Needed to book</Chip>}
                      {step.hasLeadTime && <Chip tone="warning">Start early</Chip>}
                    </span>
                    <span className="mt-1 block text-sm text-ink-700">{step.summary}</span>
                    {step.hasLeadTime && (
                      <span className="mt-1.5 block text-sm text-ink-500">
                        Someone else has to review this, so it does not finish the day you start it.
                      </span>
                    )}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>

        <form action={completeSetup} className="mt-8 flex flex-wrap items-center gap-4">
          <button
            type="submit"
            className="inline-flex h-12 items-center rounded border border-steel-300 bg-canvas px-5 text-base font-medium text-ink-700 transition-colors hover:bg-steel-100"
          >
            Skip for now and go to the app
          </button>
          <p className="text-sm text-ink-500">
            You can come back to this from Settings at any point.
          </p>
        </form>
      </div>
    </div>
  );
}
