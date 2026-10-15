import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { taskRules } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { formatDay, todayIn } from "@/lib/dates";
import { changeTemplate } from "../../rule-actions";
import { TemplateFields } from "../TemplateFields";

export const dynamic = "force-dynamic";

/**
 * ONE RECURRING TASK, TO CHANGE
 *
 * The same boxes as adding one, filled in, and held to the same rules by the
 * same route. A change applies from the next time it comes round: the tasks
 * it has already put in the queue are people's work in progress, and the page
 * says so before the button rather than after it.
 */
export default async function ChangeRecurringTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const template = (await taskRules.listTemplates(ctx)).find((t) => t.id === id);
  if (!template) notFound();
  const writes = can(user.actor, "task:write");
  const people = writes ? await taskRules.assignable(ctx) : [];
  const tz = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/tasks/recurring">Recurring tasks</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{template.title}</h1>
      <p className="mt-1 text-sm text-ink-700">
        {template.schedule}. {template.nextOn
          ? <>Next one is for {formatDay(template.nextOn, tz)}.</>
          : <Chip tone="neutral">Paused</Chip>}
      </p>

      {writes ? (
        <section aria-label="Change this recurring task" className="mt-6">
          <p className="rounded border border-steel-300 bg-steel-100 p-3 text-sm text-ink-700">
            A change applies from the next time this comes round. Tasks it has already put in the queue stay as
            they are, because somebody may be halfway through one. A day that was missed is not made up.
          </p>
          <ActionForm action={changeTemplate} submit="Save changes" className="mt-4 space-y-3" hidden={{ id: template.id }}>
            <TemplateFields template={template} people={people} today={todayIn(tz)} />
          </ActionForm>
        </section>
      ) : (
        <p className="mt-6 text-sm text-ink-700">You can look at recurring tasks. Changing one needs permission to change tasks.</p>
      )}
    </div>
  );
}
