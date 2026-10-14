"use client";

import { useState, type ChangeEvent } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { printableLogo } from "@/lib/printable-logo";
import { setBrandColor, setBrandAsset, clearBrandAsset } from "./actions";

/** The logo's limit, as core's `branding.MAX_BYTES` has it. */
const LOGO_BYTES = 512 * 1024;

/**
 * MAKING IT LOOK LIKE THEIR COMPANY
 *
 * The proposal, the invoice and the job tracking page are seen by their
 * customers rather than by ours, so this is not decoration: a product that
 * cannot do it makes a contractor look like somebody else's franchise.
 *
 * Three things, and the colour is the one with a rule behind it. A brand
 * colour gets used as a fill with words on it and as the words themselves,
 * and the second is where a real company's colour fails.
 */
export function Branding({ color, on, text, hasLogo, hasFavicon, version, logoPrints = true }: {
  color: string | null;
  on: string | null;
  text: string | null;
  hasLogo: boolean;
  hasFavicon: boolean;
  version: number;
  /** Whether the estimate and invoice PDFs can print the logo kept now. */
  logoPrints?: boolean;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold">How it looks</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Your customers see the proposal and the tracking page for their job.
        This is what they see on them.
      </p>

      <ColorForm color={color} on={on} text={text} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <AssetForm
          kind="logo" label="Logo" present={hasLogo} version={version}
          hint="PNG, JPEG, GIF, WebP, ICO or SVG, up to 512 KB. Shown in the corner of every screen and on what your customers open. A WebP or an SVG is turned into a PNG before it is sent, so it prints on your estimates and invoices."
          {...(hasLogo && !logoPrints ? {
            warning: "Your estimate and invoice PDFs leave this logo off: a PDF cannot carry its kind of picture. Upload it again here and it is turned into a PNG that prints.",
          } : {})}
        />
        <AssetForm
          kind="favicon" label="Favicon" present={hasFavicon} version={version}
          hint="PNG or ICO, up to 64 KB. The little mark on a browser tab. Square, and it is read at sixteen pixels, so a full logo turns to mush."
        />
      </div>

      <p className="mt-4 max-w-prose text-xs text-ink-500">
        {/*
          Said plainly, because somebody will try and the refusal on its own
          would look arbitrary. It is a real decision, not a limitation.
        */}
        An SVG is never stored. It can carry script, and these are served from
        the same address as the application, so your browser draws it as a
        plain picture, where nothing in it can run or fetch anything, and sends
        that picture as a PNG.
      </p>
    </section>
  );
}

function ColorForm({ color, on, text }: {
  color: string | null;
  on: string | null;
  text: string | null;
}) {
  const [state, submitForm, pending] = useKeptAction(setBrandColor, null);

  return (
    <form {...submitForm} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="block text-ink-700">Brand colour</span>
        <input
          name="color" defaultValue={color ?? ""} placeholder="#1D4ED8"
          className="mt-1 h-9 w-32 rounded border border-steel-300 px-2 font-mono"
        />
      </label>

      {color && (
        <>
          {/*
            Both forms, side by side, because they are different colours and
            an owner who sees only one will think the other is a mistake.
          */}
          <span
            className="inline-flex h-9 items-center rounded px-3 text-sm font-medium"
            style={{ backgroundColor: color, color: on ?? "#ffffff" }}
          >
            A button
          </span>
          <span className="inline-flex h-9 items-center text-sm font-medium"
                style={{ color: text ?? color }}>
            A link
          </span>
        </>
      )}

      <button type="submit" disabled={pending}
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60">
        {pending ? "Saving" : "Save"}
      </button>
      <span className="pb-2 text-xs text-ink-500">
        Leave it empty for the product&rsquo;s own colours.
      </span>

      {state && "error" in state && state.error ? (
        <span role="alert" className="pb-2 text-sm text-red-600">{state.error}</span>
      ) : null}
      {state && "note" in state && state.note ? (
        <p className="w-full text-sm text-ink-700">{state.note}</p>
      ) : null}
    </form>
  );
}

function AssetForm({ kind, label, hint, present, version, warning }: {
  kind: "logo" | "favicon";
  label: string;
  hint: string;
  present: boolean;
  version: number;
  warning?: string;
}) {
  const [state, submitForm, pending] = useKeptAction(setBrandAsset, null);
  const [, clearForm, clearing] = useKeptAction(clearBrandAsset, null);
  const [note, setNote] = useState<{ text: string; problem: boolean } | null>(null);
  const [converting, setConverting] = useState(false);

  /**
   * A logo that is a WebP or an SVG is swapped, in the box, for the PNG of
   * it before anything is sent (`printableLogo`). A favicon is left alone:
   * it never goes on a PDF, and an SVG one is refused by the server.
   */
  async function onChoose(event: ChangeEvent<HTMLInputElement>) {
    setNote(null);
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (kind !== "logo" || !file) return;
    setConverting(true);
    const made = await printableLogo(file, LOGO_BYTES);
    setConverting(false);
    if (made.kind === "unchanged") return;
    if (made.kind === "refused" || typeof DataTransfer === "undefined") {
      input.value = "";
      setNote({ text: made.kind === "refused" ? made.problem : "This browser cannot change the file. Upload a PNG.", problem: true });
      return;
    }
    const swap = new DataTransfer();
    swap.items.add(made.file);
    input.files = swap.files;
    setNote({ text: `Your ${made.from} will be sent as a PNG, so it prints on PDFs.`, problem: false });
  }

  return (
    <div className="rounded-lg border border-steel-200 bg-canvas p-4">
      <div className="flex items-center gap-3">
        {present ? (
          <img
            src={`/brand/${kind}?v=${version}`} alt={`The current ${label.toLowerCase()}`}
            className="h-10 w-10 shrink-0 rounded border border-steel-200 object-contain p-1"
          />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-dashed border-steel-300 text-xs text-ink-500">
            None
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-ink-500">{hint}</p>
        </div>
      </div>

      <form {...submitForm} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="kind" value={kind} />
        <input
          type="file" name="file"
          /*
            A hint to the file picker, not a check. The bytes decide, in
            core, and this attribute is trivially bypassed by anybody who
            wants to, which is exactly why nothing depends on it.
          */
          accept={kind === "logo"
            ? "image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/svg+xml,.svg"
            : "image/png,image/jpeg,image/gif,image/webp,image/x-icon"}
          aria-label={`${label} file`}
          onChange={onChoose}
          className="max-w-full text-sm file:mr-2 file:rounded file:border file:border-steel-300 file:bg-canvas file:px-2 file:py-1 file:text-sm"
        />
        <button type="submit" disabled={pending || converting}
                className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100 disabled:opacity-60">
          {pending ? "Saving" : present ? "Replace" : "Upload"}
        </button>
      </form>

      {present && (
        <form {...clearForm} className="mt-2">
          <input type="hidden" name="kind" value={kind} />
          <button type="submit" disabled={clearing}
                  className="text-xs text-ink-500 hover:text-red-600 hover:underline disabled:opacity-60">
            {clearing ? "Removing" : "Remove it"}
          </button>
        </form>
      )}

      {note ? (
        <p role={note.problem ? "alert" : "status"} className={`mt-2 text-sm ${note.problem ? "text-red-600" : "text-ink-700"}`}>
          {note.text}
        </p>
      ) : null}
      {warning ? <p className="mt-2 text-sm text-amber-700">{warning}</p> : null}
      {state && "error" in state && state.error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>
      ) : null}
    </div>
  );
}
