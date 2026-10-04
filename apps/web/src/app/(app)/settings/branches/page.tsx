import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { BranchesSection } from "./BranchesSection";

export const dynamic = "force-dynamic";

/**
 * SETTINGS, BRANCHES
 *
 * Where a company divides itself into the parts that each see their own
 * work. A branch here is a business unit underneath: the thing a manager is
 * measured on and the thing a job carries. What a person in a branch can see
 * is set by their role (Settings, Roles, "their branch's work"), and which
 * branch they are in is set on Settings, Team.
 */
export default async function BranchesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Branches" />
        <Empty title="Settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Branches" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A branch is a part of the company with its own work: a second shop, or a second set of books.
        A job belongs to one branch. Somebody whose role shows them their branch&apos;s work sees that
        branch&apos;s jobs, and the customers, invoices, estimates and reports that hang off them, and
        nothing else, on the board and in timesheets too. Job and invoice numbers stay one sequence for the
        whole company, with the branch&apos;s code printed in front when you turn that on below, and the price
        book is the same in every branch.
      </p>
      <div className="mt-6">
        <BranchesSection ctx={ctx} />
      </div>
    </div>
  );
}
