"use client";

import { useActionState } from "react";
import { setBrandColor, setBrandAsset, clearBrandAsset } from "./actions";

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
export function Branding({ color, on, text, hasLogo, hasFavicon, version }: {
  color: string | null;
  on: string | null;
  text: string | null;
  hasLogo: boolean;
  hasFavicon: boolean;
  version: number;
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
          hint="PNG, JPEG, GIF, WebP or ICO, up to 512 KB. Shown in the corner of every screen and on what your customers open."
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
        SVG is deliberately not accepted. An SVG can carry script, and these
        are served from the same address as the application.
      </p>
    </section>
  );
}

function ColorForm({ color, on, text }: {
  color: string | null;
  on: string | null;
  text: string | null;
}) {
  const [state, submit, pending] = useActionState(setBrandColor, null);

  return (
    <form action={submit} className="mt-4 flex flex-wrap items-end gap-3">
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

function AssetForm({ kind, label, hint, present, version }: {
  kind: "logo" | "favicon";
  label: string;
  hint: string;
  present: boolean;
  version: number;
}) {
  const [state, submit, pending] = useActionState(setBrandAsset, null);
  const [, clear, clearing] = useActionState(clearBrandAsset, null);

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

      <form action={submit} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="kind" value={kind} />
        <input
          type="file" name="file"
          /*
            A hint to the file picker, not a check. The bytes decide, in
            core, and this attribute is trivially bypassed by anybody who
            wants to, which is exactly why nothing depends on it.
          */
          accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon"
          className="max-w-full text-sm file:mr-2 file:rounded file:border file:border-steel-300 file:bg-canvas file:px-2 file:py-1 file:text-sm"
        />
        <button type="submit" disabled={pending}
                className="inline-flex h-8 items-center rounded border border-steel-300 px-2.5 text-sm hover:bg-steel-100 disabled:opacity-60">
          {pending ? "Saving" : present ? "Replace" : "Upload"}
        </button>
      </form>

      {present && (
        <form action={clear} className="mt-2">
          <input type="hidden" name="kind" value={kind} />
          <button type="submit" disabled={clearing}
                  className="text-xs text-ink-500 hover:text-red-600 hover:underline disabled:opacity-60">
            {clearing ? "Removing" : "Remove it"}
          </button>
        </form>
      )}

      {state && "error" in state && state.error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{state.error}</p>
      ) : null}
    </div>
  );
}
