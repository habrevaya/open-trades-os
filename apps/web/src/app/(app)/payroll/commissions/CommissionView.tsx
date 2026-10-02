import type { ReactNode } from "react";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

export interface PlanRow {
  id: string;
  label: string;
  basis: string;
  rate: string | null;
  flatAmount: string | null;
  note: string;
  active: boolean;
  wrongAbout: string;
}

export interface BasisRow {
  key: string;
  label: string;
  meaning: string;
  wrongAbout: string;
  needs: string;
}

/**
 * THE PLANS, EACH WITH WHAT ITS BASIS IS WRONG ABOUT
 *
 * `wrongAbout` travels with a plan everywhere it is shown, which is the service's
 * own decision and this screen keeps it. Somebody picking a commission basis is
 * writing the instruction their technicians will follow for years, usually in
 * about ninety seconds, and the sentence that would have changed their mind has to
 * be where the choice is rather than in a help article nobody opens.
 *
 * A plan is SUPERSEDED, never edited, so there is no edit control: editing one
 * reprices commissions already earned and, on a plan edited downward, already
 * paid. Deactivating and declaring a new one is the path, and this screen offers
 * exactly that.
 */
export function Plans({
  plans, controls,
}: {
  plans: PlanRow[];
  controls?: ((plan: PlanRow) => ReactNode) | undefined;
}) {
  if (plans.length === 0) {
    return (
      <Empty title="No commission plans yet">
        A plan says what a technician earns on top of their hours. Pick the basis with its caveat in
        front of you: every basis rewards something, and it is usually not quite what you meant.
      </Empty>
    );
  }
  return (
    <Table label="Commission plans" head={
      <><Th>Plan</Th><Th>Pays</Th><Th>What it rewards instead</Th>{controls ? <Th /> : null}</>
    }>
      {plans.map((plan) => (
        <tr key={plan.id} className={plan.active ? undefined : "text-ink-500"}>
          <Td>
            <span className="font-medium">{plan.label}</span>
            {plan.active
              ? <Chip tone="success" className="ml-2">Live</Chip>
              : <Chip tone="neutral" className="ml-2">Superseded</Chip>}
            <span className="block text-xs text-ink-700">{plan.note}</span>
          </Td>
          <Td className="tabular-nums">
            {/*
              A percentage or a flat amount, never both: the service requires the
              one its basis needs and refuses the other. Shown as a percentage
              rather than as the stored decimal, because "0.08" on a screen about
              pay is a number somebody reads as eight dollars.
            */}
            {plan.rate !== null
              ? <>{(Number(plan.rate) * 100).toFixed(2).replace(/\.00$/, "")}%</>
              : plan.flatAmount !== null
                ? <Money value={plan.flatAmount} />
                : <span className="text-ink-500">Not declared</span>}
            <span className="block text-xs text-ink-500">{plan.basis.replace(/_/g, " ")}</span>
          </Td>
          <Td className="text-sm text-amber-700">{plan.wrongAbout}</Td>
          {controls ? <Td>{controls(plan)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * The four bases, with the caveat on each, shown where the choice is made.
 *
 * Not a tooltip and not a link. `needs` is on it too, because a basis the company
 * cannot feed is a plan that pays nothing and looks correct: gross margin needs a
 * cost on the job, and a company that posts none would see every commission come
 * out at the full price.
 */
export function Bases({ bases }: { bases: BasisRow[] }) {
  return (
    <ul className="mt-3 space-y-3">
      {bases.map((basis) => (
        <li key={basis.key} className="rounded-md border border-steel-200 bg-canvas p-3">
          <p className="text-sm font-medium">{basis.label}</p>
          <p className="mt-1 text-sm text-ink-700">{basis.meaning}</p>
          <p className="mt-1 text-sm text-amber-700">
            <span className="font-medium">Rewards instead: </span>{basis.wrongAbout}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            <span className="font-medium">Needs: </span>{basis.needs}
          </p>
        </li>
      ))}
    </ul>
  );
}
