/**
 * The label-and-value rows every detail page uses.
 *
 * A field with no value renders nothing rather than a dash. A screen of
 * dashes reads as a broken record; an absent row reads as a record that has
 * not been filled in, which is what it is.
 */
export function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children?: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function Crumb({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-sm text-ink-500 hover:text-ink-900 hover:underline">
      {children}
    </a>
  );
}
