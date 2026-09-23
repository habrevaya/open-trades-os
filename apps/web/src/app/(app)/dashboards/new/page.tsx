import { requireSetupUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { can } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { CreateForm } from "./CreateForm";

export const dynamic = "force-dynamic";

export default async function NewDashboardPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "report:build")) redirect("/dashboards");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <PageHeader title="A new dashboard" />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        It starts empty. You add tiles by pointing them at reports you already
        have, so a tile never holds its own copy of a number: correct the
        report and every dashboard showing it is correct too.
      </p>
      <CreateForm />
    </div>
  );
}
