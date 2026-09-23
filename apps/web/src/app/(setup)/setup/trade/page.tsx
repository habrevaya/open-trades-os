import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { can } from "@opentradesos/core";
import { packSummaries } from "@opentradesos/trade-packs";
import { Logo } from "@/components/Logo";
import { chooseTrade } from "../actions";

/**
 * Step two, and deliberately early.
 *
 * Choosing a trade seeds a real price book, and every later question in the
 * wizard is easier to answer against something concrete than against an empty
 * database. Asking about tax classes or margin targets before there is a
 * single item to apply them to is how a setup flow gets abandoned.
 */
export default async function TradeStep() {
  const user = await requireUser();
  if (user.setupCompleted) redirect("/");
  if (!can(user.actor, "settings:write")) redirect("/setup");

  return (
    <div className="min-h-screen bg-canvas-raised">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <a href="/setup" className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
        </a>

        <p className="mt-10 text-sm text-ink-500">Step 2 of 10</p>
        <h1 className="mt-2 text-2xl font-semibold">What does {user.organizationName} do?</h1>
        <p className="mt-3 max-w-prose text-ink-700">
          This loads a starting price book, the job types your trade actually runs,
          checklists, the readings your technicians capture, and the numbers an owner
          in your trade manages to. Everything is yours to edit afterwards, and the
          pricing is a national average starting point rather than a recommendation.
        </p>

        <form action={chooseTrade} className="mt-8 flex flex-col gap-3">
          {packSummaries.map((pack) => (
            <button
              key={pack.id}
              type="submit"
              name="packId"
              value={pack.id}
              className="group rounded-md border border-steel-200 bg-canvas p-5 text-left transition-colors hover:border-blue-600 hover:bg-blue-100/30"
            >
              {/*
                No category chip. Each trade used to carry one reading
                "Route based" or "Crew production", and it was the first
                thing an owner saw about their own trade. A lawn company
                runs routes and sells installs; an electrician dispatches
                service and runs crews. Being told which one you are, before
                you have entered anything, is the product deciding what kind
                of business you have. The job types underneath still carry
                it, where it is a setting rather than a verdict.
              */}
              <span className="text-base font-medium group-hover:text-blue-600">{pack.name}</span>
              <p className="mt-2 text-sm text-ink-700">{pack.summary}</p>
              <p className="mt-3 text-xs text-ink-500 tnum">
                {pack.priceBookItems} price book items, {pack.jobTypes} job types
              </p>
            </button>
          ))}
        </form>

        <div className="mt-8 rounded-md border border-steel-200 bg-canvas p-5">
          <p className="text-sm font-medium">Not listed?</p>
          <p className="mt-1.5 text-sm text-ink-700">
            Skip this and build your price book yourself, or start from the closest
            trade and edit it. Packs are versioned data rather than code, so if you
            run a trade nobody has built for, yours is a contribution other people in
            your trade get too.
          </p>
          <a href="/setup" className="mt-4 inline-flex h-10 items-center rounded border border-steel-300 bg-canvas px-3.5 text-base font-medium text-ink-700 transition-colors hover:bg-steel-100">
            Skip for now
          </a>
        </div>
      </div>
    </div>
  );
}
