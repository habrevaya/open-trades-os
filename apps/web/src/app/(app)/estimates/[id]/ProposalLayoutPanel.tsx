import { proposalTemplates, proposals, type ServiceContext } from "@opentradesos/api/services";
import { ActionForm, Select } from "@/components/ActionForm";
import { addOptionPhoto, applyLayout, removeOptionPhoto } from "./layout-actions";

/**
 * HOW THIS ESTIMATE'S PROPOSAL IS LAID OUT, AND ITS OPTIONS' PHOTOGRAPHS
 *
 * Which saved layout it is drawn in (a copy, taken when it was applied) and
 * a photograph or two under each option. Both are changed only on a draft,
 * because sending froze what the customer reads; on a sent estimate the panel
 * says which layout it went out in.
 */
export async function ProposalLayoutPanel({ ctx, estimateId, status, canWrite }: {
  ctx: ServiceContext;
  estimateId: string;
  status: string;
  canWrite: boolean;
}) {
  const [doc, templates] = await Promise.all([
    proposals.proposal(ctx, { id: estimateId }),
    proposalTemplates.list(ctx),
  ]);
  const draft = status === "draft";
  const current = doc.layout.templateName;

  return (
    <section className="mt-8" aria-labelledby="proposal-layout">
      <h2 id="proposal-layout" className="text-base font-semibold">Proposal layout</h2>
      <p className="mt-1 text-sm text-ink-700">
        {current ? `Laid out as ${current}: ` : "The plain layout: "}
        {doc.layout.sections.map((s) => s.title).join(", ")}.
        {" "}<a href={`/estimates/${estimateId}/proposal`} className="underline underline-offset-4">See it</a>
      </p>
      {draft && canWrite ? (
        <>
          {templates.length > 0 ? (
            <ActionForm action={applyLayout} submit="Use this layout" tone="quiet" hidden={{ estimateId }}
                        className="mt-3 flex flex-wrap items-end gap-3">
              <Select label="Layout" name="templateId" className="block w-64"
                      defaultValue={templates.find((t) => t.name === current)?.id ?? ""}
                      options={[{ value: "", label: "The plain layout" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
            </ActionForm>
          ) : (
            <p className="mt-2 text-sm text-ink-500">
              Design one on <a href="/estimates/templates" className="underline underline-offset-4">Proposal layouts</a>.
            </p>
          )}
          {doc.layout.showOptionPhotos ? (
            <div className="mt-6 space-y-4">
              <h3 className="text-sm font-semibold">Photographs on each option</h3>
              {doc.options.map((option) => {
                const photos = doc.layout.optionPhotos[option.id] ?? [];
                return (
                  <div key={option.id} className="rounded-md border border-steel-200 p-3">
                    <p className="text-sm font-medium">{option.name}</p>
                    {photos.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-3">
                        {photos.map((photo) => (
                          <li key={photo.id} className="space-y-1">
                            <img src={`/estimates/${estimateId}/proposal/photos/${photo.id}`} alt={`${option.name}, photograph`}
                                 className="h-24 w-32 rounded object-cover" />
                            <ActionForm action={removeOptionPhoto} submit="Take it off" tone="quiet"
                                        hidden={{ estimateId, photoId: photo.id }} className="" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <ActionForm action={addOptionPhoto} submit={`Add a photograph to ${option.name}`} tone="quiet"
                                hidden={{ estimateId, optionId: option.id }} className="mt-2 flex flex-wrap items-center gap-3">
                      <input type="file" name="photo" accept="image/jpeg,image/png" aria-label={`Photograph for ${option.name}`}
                             className="text-sm" />
                    </ActionForm>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
