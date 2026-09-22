import * as React from "react";
import { cn } from "./cn";

/**
 * Inputs are 40px in the office and 48px in the field. Labels are always
 * present and always associated; a placeholder is not a label, and a form
 * filled in on a phone in a driveway is the worst place to discover that.
 */
export interface FieldProps {
  label: string;
  htmlFor?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}

export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-700">
        {label}
        {required && <span className="ml-1 text-red-600" aria-hidden>*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-red-600" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-sm text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass = (size: "md" | "lg" = "md", invalid?: boolean) =>
  cn(
    "w-full rounded border bg-canvas px-3.5 text-base text-ink-900 transition-colors",
    "placeholder:text-ink-500 focus:outline-none focus:border-blue-600",
    size === "lg" ? "h-12" : "h-10",
    invalid ? "border-red-600" : "border-steel-300",
  );

/**
 * `fieldSize`, not `size`. The native HTML input element already has a `size`
 * attribute and it is a number, so reusing the name silently widens the type
 * to string and the control height stops being checked at all.
 */
type NativeInput = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">;

export const Input = React.forwardRef<
  HTMLInputElement,
  NativeInput & { fieldSize?: "md" | "lg"; invalid?: boolean }
>(({ fieldSize = "md", invalid, className, ...props }, ref) => (
  <input ref={ref} aria-invalid={invalid || undefined} className={cn(inputClass(fieldSize, invalid), className)} {...props} />
));
Input.displayName = "Input";

/**
 * Money inputs are mono and tabular, and the value is a STRING all the way
 * through. It is never parsed to a JS number, because that is the single
 * mechanism by which a float gets into an invoice.
 */
export const MoneyInput = React.forwardRef<
  HTMLInputElement,
  Omit<NativeInput, "type"> & { fieldSize?: "md" | "lg"; invalid?: boolean }
>(({ fieldSize = "md", invalid, className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500">$</span>
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-invalid={invalid || undefined}
      className={cn(inputClass(fieldSize, invalid), "pl-7 font-mono tabular-nums", className)}
      {...props}
    />
  </div>
));
MoneyInput.displayName = "MoneyInput";
