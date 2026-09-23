import { cn } from "./cn";

/**
 * A phone number as a person reads it.
 *
 * Stored as E.164 always, because it is the one format that is unambiguous
 * across countries and the only thing a carrier will accept. Shown as E.164
 * nowhere, because `+15125550143` is a string a human has to parse digit by
 * digit, and these get read aloud off a screen while somebody dials.
 *
 * Formatting is deliberately limited to the one country whose convention we
 * can apply without guessing. A +44 number rendered with American grouping is
 * worse than an unformatted one: it looks authoritative and it is wrong.
 * Everything else is shown as stored, with the digits spaced so the eye can
 * chunk them.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const trimmed = e164.trim();
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(trimmed);
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
  return trimmed;
}

export function Phone({
  value, className,
}: { value: string | null | undefined; className?: string | undefined }) {
  if (!value) return null;
  const formatted = formatPhone(value);
  return (
    /**
     * `tel:` with the RAW value, not the formatted one. A dialler handed
     * "(512) 555-0143" mostly copes and a dialler handed E.164 always does,
     * and the number that leaves the building has to be the one that works.
     */
    <a href={`tel:${value}`} className={cn("font-mono tabular-nums hover:underline", className)}>
      {formatted}
    </a>
  );
}
