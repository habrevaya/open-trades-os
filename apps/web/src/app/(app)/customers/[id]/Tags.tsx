import { ActionForm } from "@/components/ActionForm";
import { addTag, removeTag } from "./tag-actions";

/**
 * A CUSTOMER'S TAGS, on their page.
 *
 * Each tag links to the customer list filtered by it, which is the question a
 * tag is usually for ("who else is on the storm list"), and the box offers the
 * tags the company already uses, so the next one typed is the same word rather
 * than a sixth spelling of it.
 */
export function Tags({
  customerId, tags, known, canWrite,
}: {
  customerId: string;
  tags: string[];
  /** The company's tags, for the box's suggestions. */
  known: string[];
  canWrite: boolean;
}) {
  if (tags.length === 0 && !canWrite) return null;
  return (
    <section aria-label="Tags" className="mt-8">
      <h2 className="text-base font-semibold">Tags</h2>
      {tags.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No tags yet.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <li key={tag}>
              <a href={`/customers?tag=${encodeURIComponent(tag)}`}
                 className="inline-flex h-7 items-center rounded border border-steel-300 bg-canvas px-2 text-sm hover:bg-steel-100">
                {tag}
              </a>
            </li>
          ))}
        </ul>
      )}
      {canWrite && tags.length > 0 ? (
        <ActionForm action={removeTag} submit="Take it off" tone="quiet" hidden={{ customerId }}
                    className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Tag to take off</span>
            <select name="tag" className="mt-1 h-9 w-56 rounded border border-steel-300 bg-canvas px-3 text-sm">
              {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
        </ActionForm>
      ) : null}
      {canWrite ? (
        <ActionForm action={addTag} submit="Add tag" tone="quiet" hidden={{ customerId }}
                    className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-sm font-medium text-ink-700">New tag</span>
            <input name="tag" list="company-tags" maxLength={40} required
                   className="mt-1 h-9 w-56 rounded border border-steel-300 bg-canvas px-3 text-sm" />
          </label>
          <datalist id="company-tags">
            {known.filter((tag) => !tags.includes(tag)).map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </ActionForm>
      ) : null}
    </section>
  );
}
