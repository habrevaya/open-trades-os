/**
 * THE WORDS A LIST IS SHOWING
 *
 * A plain GET form, like the branch and field filters beside it, so a
 * searched list is an address somebody can send and the search box's "See
 * all" lands on exactly this list with the words already in it. The list's
 * other filters ride along as hidden fields, so searching does not clear
 * them.
 */
export function ListSearch({
  action, q, label, placeholder, keep = {},
}: {
  /** The list's own address. */
  action: string;
  q: string | undefined;
  /** What the box is called to a screen reader: "Search jobs". */
  label: string;
  placeholder: string;
  keep?: Record<string, string | string[] | undefined>;
}) {
  return (
    <form className="mt-4" action={action} method="get" role="search">
      <input
        type="search" name="q" defaultValue={q ?? ""} placeholder={placeholder} aria-label={label}
        className="h-10 w-full max-w-sm rounded border border-steel-300 px-3 text-sm"
      />
      {Object.entries(keep).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : value ? [value] : []).map((v, i) => (
          <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
        )))}
    </form>
  );
}

/** The words from the address, trimmed, or nothing. */
export const searchWords = (value: string | string[] | undefined): string | undefined => {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 200);
  return raw ? raw : undefined;
};
