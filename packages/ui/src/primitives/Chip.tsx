import * as React from "react";
import { cn } from "./cn";
import { statusTone, type Tone } from "../tokens/index";

/**
 * Hue text on an 8 percent tint, never a solid fill. A dispatch board is
 * mostly chips, and solid fills turn it into a quilt nobody can scan.
 */
const TONES: Record<Tone, string> = {
  neutral: "bg-steel-100 text-ink-700",
  info: "bg-blue-100 text-blue-600",
  success: "bg-green-tint text-green-700",
  warning: "bg-amber-tint text-amber-700",
  danger: "bg-red-tint text-red-600",
  recurring: "bg-purple-tint text-purple-700",
};

export function Chip({
  tone = "neutral", className, children,
}: { tone?: Tone; className?: string | undefined; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

/**
 * Maps a domain status to its tone in one place. Scattering this mapping is
 * how "completed" ends up green on one screen and grey on another.
 */
export function StatusChip({ status, className }: { status: string; className?: string | undefined }) {
  const tone = (statusTone as Record<string, Tone>)[status] ?? "neutral";
  return <Chip tone={tone} className={className}>{humanize(status)}</Chip>;
}

const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
