import { customFields, customObjects, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";

/**
 * WHAT A CONDITION CAN READ, OFFERED AS THE PERSON TYPES
 *
 * A branch's condition is a path into the event, and the paths a company
 * most wants are its own: "only if the permit's status is approved", "only if
 * the job needs a permit". Those are `record.type` and `record.fields.<key>`
 * on the company's own records' events, and `job.customFields.<key>` on a
 * job's, which nobody could guess. This is a list the path boxes suggest
 * from; the box still takes any path, because the event is the authority on
 * what it carried.
 */
export async function ConditionPaths({ ctx }: { ctx: ServiceContext }) {
  const kinds = can(ctx.actor, "record:read") ? await customObjects.listKinds(ctx).catch(() => []) : [];
  const jobFields = can(ctx.actor, "job:read") ? await customFields.formFields(ctx, "job").catch(() => []) : [];
  const paths = [
    ...(kinds.length > 0 ? ["record.type", "record.title", "record.jobId", "record.customerId"] : []),
    ...[...new Set(kinds.flatMap((kind) => kind.fields.map((f) => `record.fields.${f.key}`)))],
    ...jobFields.map((f) => `job.customFields.${f.key}`),
    "job.status", "job.summary", "invoice.total", "invoice.balance",
  ];
  return (
    <datalist id="condition-paths">
      {paths.map((path) => <option key={path} value={path} />)}
    </datalist>
  );
}
