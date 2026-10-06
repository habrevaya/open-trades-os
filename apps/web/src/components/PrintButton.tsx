"use client";

/** Prints the page. A statement is a document people hand to their accounts team. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()}
            className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 print:hidden">
      {label}
    </button>
  );
}
