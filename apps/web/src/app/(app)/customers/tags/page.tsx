import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerTags } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { renameTag, mergeTags } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE COMPANY'S TAGS
 *
 * Every tag in use with how many customers carry it, each a link to the list
 * filtered by it, and the two repairs a tag list needs within a month of
 * anybody using it: a rename, and folding "vip", "V.I.P." and "VIP" into one.
 *
 * A rename onto a tag that already exists is refused rather than quietly
 * merged, because joining two segments is a decision the merge form says out
 * loud and the rename form does not.
 */
export default async function TagsPage() {
  const user = await requireSetupUser();
  const tags = await customerTags.list({ actor: user.actor, db: getDb() });
  const writes = can(user.actor, "customer:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/customers">Customers</Crumb>
      <div className="mt-1">
        <PageHeader title="Tags" count={tags.length} />
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Tags are compared without capitals, so &ldquo;vip&rdquo; and &ldquo;VIP&rdquo; are one tag, and a
        new tag typed on a customer takes the spelling already here.
      </p>

      {tags.length === 0 ? (
        <Empty title="No tags yet">Add one from a customer&rsquo;s page, and it shows up here with a count.</Empty>
      ) : (
        <Table label="Tags in use" head={<><Th>Tag</Th><Th className="text-right">Customers</Th>{writes ? <Th>Rename</Th> : null}</>}>
          {tags.map(({ tag, customers }) => (
            <tr key={tag}>
              <Td>
                <a href={`/customers?tag=${encodeURIComponent(tag)}`} className="font-medium hover:underline">{tag}</a>
              </Td>
              <Td className="text-right tabular-nums">{customers}</Td>
              {writes ? (
                <Td>
                  <ActionForm action={renameTag} submit="Rename" tone="quiet" hidden={{ from: tag }}
                              className="flex flex-wrap items-center gap-2">
                    <input name="to" required maxLength={40} defaultValue={tag} aria-label={`New name for ${tag}`}
                           className="h-9 w-48 rounded border border-steel-300 bg-canvas px-3 text-sm" />
                  </ActionForm>
                </Td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}

      {writes && tags.length > 1 && (
        <section aria-label="Merge tags" className="mt-10">
          <h2 className="text-base font-semibold">Merge tags</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-700">
            Every customer carrying any ticked tag carries the new one instead, once, where the
            first of them was.
          </p>
          <ActionForm action={mergeTags} submit="Merge them" className="mt-3 space-y-3">
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-sm font-medium text-ink-700">Tags to fold in</legend>
              {tags.map(({ tag }) => (
                <label key={tag} className="inline-flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="from" value={tag} /> {tag}
                </label>
              ))}
            </fieldset>
            <TextField label="Into" name="into" required maxLength={40} className="block max-w-xs" />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
