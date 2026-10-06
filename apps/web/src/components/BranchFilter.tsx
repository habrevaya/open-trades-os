import type { branches } from "@opentradesos/api/services";

/**
 * THE BRANCH A LIST IS SHOWING
 *
 * A plain GET form, so the filtered list is an address somebody can send, and
 * it works with JavaScript off like every other filter in the office app.
 *
 * Drawn only for somebody who sees the whole company in a company that has
 * branches. A Houston manager's lists are already Houston's, and offering them
 * Austin would be offering an empty list; a company with one shop has nothing
 * to choose between.
 */
export function BranchFilter({
  options, action, current, keep = {}, none = false,
}: {
  options: branches.BranchOptions;
  /** The list's own address. */
  action: string;
  /** The branch chosen now, `none`, or empty for every branch. */
  current: string | undefined;
  /** The list's other filters, so choosing a branch does not clear them. */
  keep?: Record<string, string | string[] | undefined>;
  /** Offer "No branch", for the list where unsorted work is found. */
  none?: boolean;
}) {
  if (options.narrowed || options.branches.length === 0) return null;
  return (
    <form action={action} method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm" aria-label="Filter by branch">
      {Object.entries(keep).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : value ? [value] : []).map((v, i) => (
          <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
        )))}
      <label className="flex flex-col gap-1">
        <span className="text-ink-700">Branch</span>
        <select name="branch" defaultValue={current ?? ""} className="h-9 rounded border border-steel-300 px-2">
          <option value="">Every branch</option>
          {options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          {none ? <option value="none">No branch yet</option> : null}
        </select>
      </label>
      <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 font-medium hover:bg-steel-100">
        Show
      </button>
    </form>
  );
}

/** A branch from the address, if it is one the filter offers. Anything else is every branch. */
export function chosenBranch(
  options: branches.BranchOptions, value: string | string[] | undefined, allowNone = false,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || options.narrowed) return undefined;
  if (raw === "none") return allowNone ? "none" : undefined;
  return options.branches.some((b) => b.id === raw) ? raw : undefined;
}
