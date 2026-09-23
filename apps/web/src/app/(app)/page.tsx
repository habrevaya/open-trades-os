import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatch } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";

export const dynamic = "force-dynamic";

/**
 * "Today" rather than "Dashboard". An owner opening this at 6am wants to know
 * what is happening today, not to admire a chart. What each role sees first
 * differs, because a dispatcher and an accountant are not doing the same job.
 */
export default async function TodayPage() {
  const user = await requireSetupUser();

  /**
   * Field staff land on their own day, not on this.
   *
   * Somebody who can use the field app and cannot dispatch is a technician or
   * a crew lead, and for them this screen is a summary of a business they do
   * not run. They open the app standing in a driveway wanting to know which
   * house is next, and making them find a second link first is the difference
   * between an app they use and one they are told to use.
   */
  if (can(user.actor, "field:sync") && !can(user.actor, "visit:dispatch")) {
    redirect("/my-day");
  }
  const seesMoney = can(user.actor, "report.financial:read");

  /**
   * Real numbers, from the same query the board uses.
   *
   * These were four hardcoded zeros under a real heading, which is the worst
   * version: a screen that says "0 completed" is making a claim, and an owner
   * who has finished six jobs reads it as the product being wrong about their
   * day rather than as a placeholder.
   *
   * Counted from the board rather than with four aggregate queries, because
   * the board is one query the dispatcher's screen already runs and the
   * numbers then cannot disagree with the screen they link to.
   */
  const today = todayIn(user.organizationTimezone);
  const board = await dispatch.board({ actor: user.actor, db: getDb() }, { date: today });

  const scheduled = board.technicians.reduce((n, t) => n + t.visits.length, 0);
  const unassigned = board.unassigned.length;
  const completed = board.technicians
    .reduce((n, t) => n + t.visits.filter((v) => v.status === "completed").length, 0);
  const empty = scheduled === 0 && unassigned === 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-sm text-ink-500">
          {/*
            The company's date, not the server's. A shop in Austin looking at
            a server in UTC at nine in the evening would otherwise be told it
            is already tomorrow.
          */}
          {new Date().toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric",
            timeZone: user.organizationTimezone,
          })}
        </span>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Visits today" value={String(scheduled + unassigned)} />
        {/*
          The tone appears only when the number means something. A "Needs
          action" badge over a zero trains people to ignore the badge.
        */}
        <Stat label="Unassigned" value={String(unassigned)} {...(unassigned > 0 ? { tone: "warning" as const } : {})} />
        <Stat label="Completed" value={String(completed)} {...(completed > 0 ? { tone: "success" as const } : {})} />
      </div>

      {seesMoney ? (
        <p className="mt-3 text-sm text-ink-500">
          {/* Invoiced today was a hardcoded $0.00 here. It needs a sum over
              today's invoices, which is a report rather than a board read,
              so it is named as missing rather than shown as zero. */}
          Revenue for the day is not on this screen yet.
        </p>
      ) : null}

      {empty ? (
      <div className="mt-8 rounded-md border border-steel-200 bg-canvas p-8 text-center">
        <p className="font-medium">Nothing scheduled today</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-700">
          Add a customer and book their first job. The board fills in from there.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {can(user.actor, "customer:write") && (
            <a href="/customers/new" className="btn-solid inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-base font-medium text-white transition-colors hover:bg-ink-700">
              Add a customer
            </a>
          )}
          <a href="/pricebook" className="inline-flex h-10 items-center rounded border border-steel-300 bg-canvas px-3.5 text-base font-medium text-ink-700 transition-colors hover:bg-steel-100">
            Review the price book
          </a>
        </div>
      </div>
      ) : (
        <div className="mt-8">
          <a href="/schedule" className="text-sm font-medium text-ink-900 hover:underline">
            Open the board
          </a>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, mono }: {
  label: string; value: string; tone?: "warning" | "success"; mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-steel-200 bg-canvas p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.08em] text-ink-500">{label}</p>
        {tone && <Chip tone={tone}>{tone === "warning" ? "Needs action" : "Done"}</Chip>}
      </div>
      <p className={`mt-3 text-2xl font-semibold ${mono ? "font-mono tabular-nums" : ""}`}>{value}</p>
    </div>
  );
}
