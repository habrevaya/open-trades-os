import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inspections, priceBook } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ProgramEditor, type EditorProgramme } from "../ProgramEditor";
import { packName } from "../words";

export const dynamic = "force-dynamic";

/**
 * WRITE A PROGRAMME, FROM NOTHING OR FROM A COPY
 *
 * `?pack=plumbing&code=backflow-annual` starts from a trade pack's programme,
 * `?from=<id>` from one the company already has. Nothing is saved until the
 * copy is: the editor opens with the copy in it and says what has to be fixed
 * before an inspection could be filed against it, because a copy that kept a
 * reading with no range would be a programme nobody can finish. Saved, it
 * says where it came from.
 *
 * Needs `compliance:write`, as `POST /v1/inspection-programs` does.
 */
export default async function NewProgrammePage({
  searchParams,
}: {
  searchParams: Promise<{ pack?: string; code?: string; from?: string }>;
}) {
  const { pack, code, from } = await searchParams;
  const user = await requireSetupUser();
  if (!can(user.actor, "compliance:write")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="New inspection programme" />
        <Empty title="Writing programmes is not part of your access">
          It needs the permission to manage compliance records. Somebody who can change roles can give it to you.
        </Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };

  let programme: EditorProgramme = {
    name: "", standard: null, reportAudience: "customer", authorityName: null, frequencyMonths: 12,
    checkpoints: [{ key: "", label: "" }],
  };
  let copiedFrom: string | undefined;
  let replaceable: { id: string; name: string; ticked: boolean } | null = null;
  let problems: string[] = [];
  let heading = "New inspection programme";
  let lead = "Write the checkpoints a technician answers, in order. Saved, it is version 1 and offered to technicians at once.";

  if (pack && code) {
    const source = (await inspections.packPrograms(ctx)).find((p) => p.packId === pack && p.code === code);
    if (!source) {
      return (
        <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
          <PageHeader title={heading} />
          <Empty title="That trade pack programme is not here">
            <Link href="/inspections/programmes" className="underline underline-offset-4">Back to the programmes</Link>
          </Empty>
        </div>
      );
    }
    programme = {
      name: source.name, standard: source.standard, reportAudience: source.reportAudience, authorityName: null,
      frequencyMonths: source.frequencyMonths, checkpoints: source.checkpoints,
    };
    copiedFrom = `pack:${source.packId}:${source.code}`;
    problems = source.problems;
    if (source.inCompany?.offered) replaceable = {
      id: source.inCompany.id, name: `the ${packName(source.packId)} trade pack's own ${source.name}`, ticked: true,
    };
    heading = `Your own ${source.name}`;
    lead = `A copy of the ${source.packName} trade pack's programme. Change what you need, then save it as your own.`;
  } else if (from) {
    const source = await inspections.program(ctx, { id: from });
    programme = {
      name: `${source.program.name} (copy)`, standard: source.program.standard, reportAudience: source.program.reportAudience,
      authorityName: source.program.authorityName, frequencyMonths: source.program.frequencyMonths,
      checkpoints: source.program.checkpoints,
    };
    copiedFrom = `program:${source.program.id}`;
    problems = source.program.problems;
    if (source.program.active) replaceable = { id: source.program.id, name: source.program.name, ticked: false };
    heading = `A copy of ${source.program.name}`;
    lead = `Copied from version ${source.program.version}. Change what you need, then save it as a programme of its own.`;
  }

  const [appliesTo, items] = await Promise.all([
    inspections.appliesToChoices(ctx),
    can(user.actor, "pricebook:read") ? priceBook.list(ctx, { limit: 200, includeInactive: false }).then((r) => r.data) : [],
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <p className="text-sm"><Link href="/inspections/programmes" className="text-ink-500 hover:underline">Inspection programmes</Link></p>
      <PageHeader title={heading} />
      <p className="mt-2 max-w-prose text-sm text-ink-700">{lead}</p>
      <ProgramEditor
        mode="new"
        programme={programme}
        copiedFrom={copiedFrom}
        replaceable={replaceable}
        appliesTo={appliesTo}
        priceBook={items.map((i) => ({ code: i.code ?? "", name: i.name })).filter((i) => i.code !== "")}
        problems={problems}
      />
    </div>
  );
}
