import { getDb } from "@/lib/db";
import { tradePacks } from "@opentradesos/api/services";
import { setup as rules } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { StepFrame, loadStep } from "../StepFrame";
import { chooseTrade, upgradePack } from "../actions";

export const dynamic = "force-dynamic";

/** A changed value as an owner reads it. */
function shown(change: rules.FieldChange, side: "from" | "to"): string {
  const value = change[side];
  if (value === null) return change.field === "cost" ? "hidden" : "none";
  if (change.field === "price" || change.field === "cost") return `$${Number(value).toFixed(2)}`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function Changes({ changes }: { changes: rules.FieldChange[] }) {
  return (
    <span className="text-ink-500">
      {changes.map((c) => `${rules.FIELD_LABELS[c.field]} ${shown(c, "from")} to ${shown(c, "to")}`).join(", ")}
    </span>
  );
}

/**
 * STEP TWO, DELIBERATELY EARLY, AND WHERE A NEWER PACK ARRIVES LATER
 *
 * Choosing a trade seeds a real price book, and every later question in the
 * wizard is easier to answer against something concrete than against an
 * empty database. Asking about tax classes or margin targets before there is
 * a single item to apply them to is how a setup flow gets abandoned.
 *
 * When this product ships a newer version of a pack the company is running,
 * this page shows exactly what it would change before anything is written:
 * what it adds, what it updates (only items still exactly as the old version
 * seeded them), and what it leaves alone because somebody here changed it or
 * made it. Nothing the company changed is overwritten, and nothing is deleted.
 */
const kindOf = (kind: rules.SetupKind) => rules.SETUP_KIND_LABELS[kind].toLowerCase();
const partsOf = (parts: readonly string[]) =>
  parts.map((part) => (rules.SETUP_PART_LABELS[part] ?? part).toLowerCase()).join(", ");
/** Why something the new version changes stays as the company has it, in a sentence. */
const KEPT_BECAUSE: Record<rules.SetupKeptReason, string> = {
  edited: "you changed it.",
  yours: "you made it yourselves under the same name.",
  removed: "you took it out, and it is not put back.",
  purging: "purging is on for this rule and the new version keeps records for less time, so that is yours to decide.",
};

export default async function TradeStep() {
  const { user, allowed } = await loadStep("trade");
  const ctx = { actor: user.actor, db: getDb() };
  const standing = await tradePacks.standings(ctx);
  const applied = standing.packs.filter((p) => p.applied !== null);
  const plans = allowed
    ? await Promise.all(applied.filter((p) => p.upgradable).map((p) => tradePacks.previewUpgrade(ctx, p.id)))
    : [];

  return (
    <StepFrame stepKey="trade" user={user} allowed={allowed}
               intro="This loads a starting price book, the job types your trade actually runs, checklists, the readings your technicians capture, and the numbers an owner in your trade manages to. Everything is yours to edit afterwards, and the pricing is a national average starting point rather than a recommendation.">
      {applied.length > 0 ? (
        <section aria-labelledby="running" className="mb-8">
          <h2 id="running" className="text-base font-semibold">What you are running</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-700">
            {applied.map((p) => (
              <li key={p.id}>
                {p.name}, version {p.applied}
                {p.upgradable ? <span className="text-amber-700"> (version {p.version} is out)</span> : <span className="text-ink-500"> (the newest)</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {plans.map((plan) => {
        const pack = standing.packs.find((p) => p.id === plan.packId)!;
        return (
          <section key={plan.packId} aria-labelledby={`upgrade-${plan.packId}`} className="mb-8 rounded-md border border-amber-700 bg-amber-tint p-4">
            <h2 id={`upgrade-${plan.packId}`} className="text-base font-semibold">
              {pack.name} version {plan.toVersion}: what it would change
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-ink-900">
              <li>{plan.add.length} new {plan.add.length === 1 ? "item" : "items"} added{plan.add.length > 0 ? `: ${plan.add.map((a) => a.name).join(", ")}` : ""}.</li>
              <li>{plan.update.length} {plan.update.length === 1 ? "item" : "items"} you have not changed take the new values.</li>
              <li>{plan.kept.length} {plan.kept.length === 1 ? "item" : "items"} you changed or made yourselves stay exactly as they are.</li>
              <li>{plan.unchanged} already match.</li>
              {plan.dropped.length > 0 ? <li>{plan.dropped.length} the new version no longer has are kept, because invoices point at them.</li> : null}
              {plan.jobTypes.add.length > 0 ? <li>Job types added: {plan.jobTypes.add.map((t) => t.name).join(", ")}.</li> : null}
              {plan.setup.add.length > 0 ? (
                <li>Set up for the first time: {plan.setup.add.map((a) => `${a.name} (${kindOf(a.kind)})`).join(", ")}.</li>
              ) : null}
              {plan.setup.update.length > 0 ? (
                <li>{plan.setup.update.map((u) => `${u.name} (${kindOf(u.kind)})`).join(", ")}: you have not changed {plan.setup.update.length === 1 ? "it, so it takes" : "them, so they take"} the new version.</li>
              ) : null}
              {plan.setup.kept.length > 0 ? (
                <li>{plan.setup.kept.length} of your report, inspection, retention and portal settings stay exactly as they are.</li>
              ) : null}
            </ul>
            {plan.update.length > 0 ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-medium">What updates</summary>
                <ul className="mt-1 space-y-0.5">
                  {plan.update.map((u) => <li key={u.code}>{u.name}: <Changes changes={u.changes} /></li>)}
                </ul>
              </details>
            ) : null}
            {plan.kept.length > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-medium">What stays yours</summary>
                <ul className="mt-1 space-y-0.5">
                  {plan.kept.map((k) => (
                    <li key={k.code}>
                      {k.name} ({k.reason === "edited" ? "you changed it" : "you made it"}). The new version says: <Changes changes={k.changes} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {plan.setup.update.length > 0 || plan.setup.kept.length > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-medium">Reports, inspections, retention and the portal</summary>
                <ul className="mt-1 space-y-0.5">
                  {plan.setup.update.map((u) => (
                    <li key={`${u.kind}:${u.key}`}>{u.name} ({kindOf(u.kind)}) takes the new {partsOf(u.changed)}.</li>
                  ))}
                  {plan.setup.kept.map((k) => (
                    <li key={`${k.kind}:${k.key}`}>
                      {k.name} ({kindOf(k.kind)}) stays as it is: {KEPT_BECAUSE[k.reason]}
                      {k.changed.length > 0 ? ` The new version changes its ${partsOf(k.changed)}.` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <ActionForm action={upgradePack} submit={`Upgrade to version ${plan.toVersion}`}
                        hidden={{ packId: plan.packId }} className="mt-4 space-y-2" />
          </section>
        );
      })}

      <h2 className="text-base font-semibold">{applied.length > 0 ? "Add another trade" : "What does your company do?"}</h2>
      <form action={chooseTrade} className="mt-3 flex flex-col gap-3">
        {standing.packs.map((pack) => (
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
              service and runs crews. The job types underneath still carry
              it, where it is a setting rather than a verdict.
            */}
            <span className="text-base font-medium group-hover:text-blue-600">{pack.name}</span>
            {pack.applied !== null ? <span className="ml-2 text-sm text-ink-500">(loaded)</span> : null}
            <p className="mt-2 text-sm text-ink-700">{pack.summary}</p>
            <p className="mt-3 text-xs text-ink-500 tnum">
              {pack.priceBookItems} price book items, {pack.jobTypes} job types
            </p>
          </button>
        ))}
      </form>

      <div className="mt-6 rounded-md border border-steel-200 bg-canvas-raised p-4">
        <p className="text-sm font-medium">Not listed?</p>
        <p className="mt-1.5 text-sm text-ink-700">
          Skip this and build your price book yourself, or start from the closest trade and edit it. Packs
          are versioned data rather than code, so if you run a trade nobody has built for, yours is a
          contribution other people in your trade get too. Applying a second pack adds to the first and
          never overwrites it.
        </p>
      </div>
    </StepFrame>
  );
}
