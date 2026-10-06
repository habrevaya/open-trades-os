import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, proposalTemplates } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { startTemplate } from "./actions";

export const dynamic = "force-dynamic";

/**
 * PROPOSAL LAYOUTS
 *
 * How the company's proposals read: a cover with a photograph, then the
 * sections it sells in, in its own order. One can be the default and one can
 * belong to each job type, and a new estimate starts with its job type's or
 * the default; an estimate keeps the copy it was given.
 */
export default async function TemplatesPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const [templates, types] = await Promise.all([
    proposalTemplates.list(ctx),
    can(user.actor, "job:read") ? jobs.listTypes(ctx, { includeInactive: false }).then((r) => r.data) : [],
  ]);
  const writes = can(user.actor, "settings:write");
  const typeName = new Map(types.map((t) => [t.id, t.name] as const));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Proposal layouts" count={templates.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A cover with your photograph, then about you, the options, your warranty, financing, what customers said and
        the small print, in the order you sell in. The printed proposal, the customer&apos;s link and the PDF all follow it.
        {!writes ? " Changing them needs the Edit company settings permission." : ""}
      </p>
      {templates.length === 0 ? (
        <Empty title="No layouts yet">Proposals use the plain layout: the options, then the terms.</Empty>
      ) : (
        <Table head={<><Th>Layout</Th><Th>Starts estimates for</Th><Th>Sections</Th></>}>
          {templates.map((t) => (
            <tr key={t.id}>
              <Td>
                <a href={`/estimates/templates/${t.id}`} className="font-medium underline underline-offset-4">{t.name}</a>
                {t.isDefault ? <span className="ml-2"><Chip tone="info">Default</Chip></span> : null}
              </Td>
              <Td className="text-ink-700">{t.jobTypeId ? typeName.get(t.jobTypeId) ?? "A retired job type" : t.isDefault ? "Everything else" : ""}</Td>
              <Td className="text-ink-700">{t.layout.sections.map((s) => s.title).join(", ")}</Td>
            </tr>
          ))}
        </Table>
      )}
      {writes ? (
        <section className="mt-10" aria-labelledby="start-layout">
          <h2 id="start-layout" className="text-base font-semibold">Start a layout</h2>
          <ActionForm action={startTemplate} submit="Start it" hidden={{ companyName: user.organizationName }}
                      className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
            <TextField label="Name" name="name" required maxLength={80} placeholder="Installs" />
            <Select label="Starts every estimate for" name="jobTypeId"
                    options={[{ value: "", label: "No job type in particular" }, ...types.map((t) => ({ value: t.id, label: t.name }))]} />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="isDefault" className="h-4 w-4" />
              The default, for every estimate whose job type has no layout of its own
            </label>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
