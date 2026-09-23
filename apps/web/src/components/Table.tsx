import { cn } from "@opentradesos/ui";

/**
 * The list screens share a shape, so they share a component.
 *
 * Deliberately thin. A generic data grid with sorting, column config and
 * virtualization would be the obvious next step and is the wrong one here:
 * every screen in this product shows a few hundred rows at most, and the
 * abstraction costs more to read than the five list pages it replaces.
 */
export function Table({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-6 overflow-x-auto rounded-md border border-steel-200">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b border-steel-200 bg-steel-100 text-left">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-steel-200">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("px-4 py-2.5 font-medium text-ink-700", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3 align-top", className)}>{children}</td>;
}

/**
 * What a list shows when it is empty.
 *
 * Says what to do next rather than "No results". An empty screen with no next
 * step is where a trial ends, and the first hour with this product is a lot
 * of empty screens.
 */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-md border border-steel-200 bg-canvas p-8 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-md text-sm text-ink-700">{children}</div> : null}
    </div>
  );
}

export function PageHeader({
  title, count, action,
}: { title: string; count?: number | undefined; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {count === undefined ? null : (
          <span className="text-sm text-ink-500">{count === 1 ? "1 record" : `${count} records`}</span>
        )}
      </div>
      {action}
    </div>
  );
}
