import * as React from "react";
import { cn } from "./cn";

/**
 * Five variants, three sizes.
 *
 * `solid` is ink900, not blue. A near black button is unambiguous in sunlight,
 * and it frees blue entirely to mean state rather than action. If two things
 * on a screen are blue, one of them is wrong.
 *
 * `lg` is 48px. That is the smallest target a person wearing a work glove hits
 * reliably, so the field app uses it everywhere.
 */
export type ButtonVariant = "solid" | "outline" | "ghost" | "soft" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  solid: "bg-ink-900 text-white hover:bg-ink-700",
  outline: "bg-canvas text-ink-700 border border-steel-300 hover:bg-steel-100",
  ghost: "text-ink-700 hover:bg-steel-100",
  soft: "bg-blue-100 text-blue-600 hover:bg-blue-300/40",
  danger: "bg-red-600 text-white hover:brightness-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-[10px] text-sm gap-1.5",
  md: "h-10 px-[14px] text-base gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  loading?: boolean | undefined;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "outline", size = "md", loading, disabled, className, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center rounded font-medium transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
