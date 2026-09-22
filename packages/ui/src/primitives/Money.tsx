import { cn } from "./cn";

/**
 * Money is always mono and tabular. Job numbers and dollar amounts get read
 * aloud over a phone and compared down a column, and proportional digits make
 * both harder than they need to be.
 */
export function Money({
  value, currency = "USD", className, muted,
}: { value: string | null | undefined; currency?: string; className?: string | undefined; muted?: boolean }) {
  if (value == null) return <span className={cn("text-ink-500", className)}>&mdash;</span>;
  const n = Number(value);
  const formatted = Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n)
    : value;
  return (
    <span className={cn("font-mono tabular-nums", muted ? "text-ink-500" : "text-ink-900", n < 0 && "text-red-600", className)}>
      {formatted}
    </span>
  );
}
