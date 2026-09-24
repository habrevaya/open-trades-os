import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { workflows } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { CreateForm } from "./CreateForm";

export const dynamic = "force-dynamic";

export default async function NewAutomationPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "workflow:write")) notFound();

  const events = await workflows.triggerEventCatalogue(ctx);
  const steps = workflows.availableSteps(ctx);
  const shapes = workflows.dwellShapes();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <a href="/automations" className="text-sm text-ink-500 hover:underline">Automations</a>
      <div className="mt-2">
        <PageHeader title="New automation" />
      </div>
      {/*
        Said before they start, not after they save. A new automation that
        began running the moment it was saved would send its first message
        before anybody had read it back.
      */}
      <p className="mt-1 text-sm text-ink-700">
        It is saved switched off. Read it back, then turn it on.
      </p>

      <CreateForm events={events} steps={steps} shapes={shapes} />
    </div>
  );
}
