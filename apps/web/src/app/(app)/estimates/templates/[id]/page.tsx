import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, proposalTemplates, NotFoundError } from "@opentradesos/api/services";
import { can, estimate as est } from "@opentradesos/core";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { retireTemplate, saveTemplate, uploadCover } from "../actions";

export const dynamic = "force-dynamic";

const KIND_OPTIONS = [
  { value: "", label: "Take this section out" },
  ...est.SECTION_KINDS.map((kind) => ({ value: kind, label: est.SECTION_LABEL[kind] })),
];

/**
 * ONE PROPOSAL LAYOUT, EDITED
 *
 * The cover, then a row per section in order: what kind it is, its heading,
 * its words and where it goes. Moving a section is changing its position
 * number; taking one out is choosing "Take this section out"; the last row is
 * blank for adding one. Everything is checked when it is saved, every
 * problem at once, by the same rules the PDF and the customer's page are
 * drawn under.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { id } = await params;
  const template = await proposalTemplates.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const types = can(user.actor, "job:read") ? (await jobs.listTypes(ctx, { includeInactive: false })).data : [];
  const writes = can(user.actor, "settings:write");
  const rows = [...template.layout.sections, null];
  const cover = template.layout.cover;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/estimates/templates">Proposal layouts</Crumb>
      <div className="mt-2"><PageHeader title={template.name} /></div>

      {!writes ? (
        <ol className="mt-6 list-decimal space-y-1 pl-5 text-sm">
          {template.layout.sections.map((s, i) => <li key={i}>{s.title}</li>)}
        </ol>
      ) : (
        <>
          <ActionForm action={saveTemplate} submit="Save the layout" hidden={{ id }} className="mt-6 space-y-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Name" name="name" required maxLength={80} defaultValue={template.name} />
              <Select label="Starts every estimate for" name="jobTypeId" defaultValue={template.jobTypeId ?? ""}
                      options={[{ value: "", label: "No job type in particular" }, ...types.map((t) => ({ value: t.id, label: t.name }))]} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isDefault" defaultChecked={template.isDefault} className="h-4 w-4" />
                The default for every other estimate
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="showOptionPhotos" defaultChecked={template.layout.showOptionPhotos} className="h-4 w-4" />
                Show the photographs put on each option
              </label>
            </div>

            <fieldset className="space-y-3 rounded-md border border-steel-200 p-4">
              <legend className="px-1 text-sm font-medium">The cover</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="cover" defaultChecked={cover !== null} className="h-4 w-4" />
                Open the proposal on a cover page
              </label>
              <TextField label="Headline" name="headline" maxLength={120} defaultValue={cover?.headline ?? `A proposal from ${user.organizationName}`} />
              <TextArea label="A sentence or two under it" name="intro" rows={2} maxLength={600} defaultValue={cover?.intro ?? ""} />
              <p className="text-xs text-ink-500">
                {cover?.photoKey ? "The cover has a photograph; upload another below to replace it." : "Add a photograph below."}
              </p>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-sm font-medium">Sections, in order</legend>
              {rows.map((section, index) => (
                <div key={index} role="group" className="grid gap-3 rounded-md border border-steel-200 p-4 sm:grid-cols-[6rem_1fr_1fr]"
                     aria-label={section ? `Section ${index + 1}` : "A new section"}>
                  <TextField label="Position" name={`s${index}.position`} type="number" min={1} max={20}
                             defaultValue={String(index + 1)} />
                  <Select label={section ? "What it is" : "Add a section"} name={`s${index}.kind`}
                          defaultValue={section?.kind ?? ""} options={KIND_OPTIONS} />
                  <TextField label="Heading" name={`s${index}.title`} maxLength={80} defaultValue={section?.title ?? ""} />
                  <div className="sm:col-span-3">
                    <TextArea label="Words under it (the options and the terms draw the estimate's own)" name={`s${index}.body`}
                              rows={3} maxLength={4000} defaultValue={section?.body ?? ""} />
                  </div>
                  {section?.kind === "reviews" ? (
                    <div className="grid gap-3 sm:col-span-3 sm:grid-cols-2">
                      <TextField label="Lowest rating shown (1 to 5)" name={`s${index}.minRating`} type="number" min={1} max={5}
                                 defaultValue={String(section.minRating ?? 5)} />
                      <TextField label="How many (1 to 6)" name={`s${index}.count`} type="number" min={1} max={6}
                                 defaultValue={String(section.count ?? 3)} />
                    </div>
                  ) : null}
                </div>
              ))}
            </fieldset>
          </ActionForm>

          <section className="mt-10" aria-labelledby="cover-photo">
            <h2 id="cover-photo" className="text-base font-semibold">The cover photograph</h2>
            {cover?.photoKey ? (
              <img src={`/estimates/templates/${id}/cover`} alt="The cover photograph"
                   className="mt-3 max-h-64 rounded-md border border-steel-200 object-cover" />
            ) : null}
            <ActionForm action={uploadCover} submit="Upload the photograph" hidden={{ id }} tone="quiet" className="mt-3 space-y-3">
              <label className="block">
                <span className="text-sm font-medium text-ink-700">A JPEG or PNG, up to 8 MB</span>
                <input type="file" name="photo" accept="image/jpeg,image/png" className="mt-1 block text-sm" />
              </label>
            </ActionForm>
          </section>

          <section className="mt-10" aria-labelledby="retire-layout">
            <h2 id="retire-layout" className="text-base font-semibold">Retire it</h2>
            <p className="mt-1 text-sm text-ink-700">Estimates it is on keep their copy. New ones stop starting with it.</p>
            <ActionForm action={retireTemplate} tone="danger" submit={`Retire ${template.name}`} hidden={{ id }} className="mt-3" />
          </section>
        </>
      )}
    </div>
  );
}
