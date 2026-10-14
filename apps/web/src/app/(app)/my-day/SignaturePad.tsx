"use client";

import { useEffect, useRef, useState } from "react";

/** What a form holds to empty the canvas from its own button. */
export interface InkHandle { clear: () => void }

/**
 * THE CANVAS ALONE
 *
 * The drawing surface with no buttons, for a form that files something else
 * and wants the signature as one of its fields (an inspection). It reports
 * the picture each time a stroke ends, and `null` once it is cleared, so the
 * form never has to reach into the canvas when its own button is pressed.
 * `SignaturePad` below is this canvas with a Sign button and a Clear button.
 */
export function SignatureCanvas({
  label, onChange, handle,
}: {
  label: string;
  /** The picture after each stroke, or null when there is nothing drawn. */
  onChange: (png: string | null) => void;
  handle?: React.RefObject<InkHandle | null>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const marked = useRef(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // Drawn at the device's pixel density so the line is not blurred on a phone.
    const ratio = window.devicePixelRatio || 1;
    element.width = element.clientWidth * ratio;
    element.height = element.clientHeight * ratio;
    const context = element.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.strokeStyle = "#111827";
  }, []);

  useEffect(() => {
    if (!handle) return;
    handle.current = {
      clear: () => {
        const element = canvas.current;
        element?.getContext("2d")?.clearRect(0, 0, element.width, element.height);
        marked.current = false;
        onChange(null);
      },
    };
    return () => { handle.current = null; };
  });

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  /** A stroke has ended: hand over the picture, if anything was drawn. */
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (marked.current && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  };

  return (
    <canvas
      ref={canvas}
      aria-label={label}
      role="img"
      className="h-32 w-full touch-none rounded border border-steel-300 bg-canvas"
      onPointerDown={(event) => {
        const context = event.currentTarget.getContext("2d");
        if (!context) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = true;
        const { x, y } = point(event);
        context.beginPath();
        context.moveTo(x, y);
      }}
      onPointerMove={(event) => {
        if (!drawing.current) return;
        const context = event.currentTarget.getContext("2d");
        if (!context) return;
        const { x, y } = point(event);
        context.lineTo(x, y);
        context.stroke();
        marked.current = true;
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={finish}
    />
  );
}

/**
 * A FINGER ON THE SCREEN, AS A PICTURE
 *
 * A canvas the technician draws on with a finger or a mouse, handed back as a
 * PNG when they press the button. Pointer events, so a finger, a stylus and a
 * mouse are one code path, and `touch-action: none` so drawing does not
 * scroll the page out from under the stroke.
 */
export function SignaturePad({
  label, onSign, pending,
}: {
  label: string;
  onSign: (png: string) => void;
  pending: boolean;
}) {
  const handle = useRef<InkHandle | null>(null);
  const [png, setPng] = useState<string | null>(null);

  return (
    <div>
      <SignatureCanvas label={label} onChange={setPng} handle={handle} />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!png || pending}
          onClick={() => png && onSign(png)}
          className="inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Signing" : "Sign"}
        </button>
        <button
          type="button"
          disabled={!png || pending}
          onClick={() => handle.current?.clear()}
          className="inline-flex h-10 items-center rounded border border-steel-300 px-4 text-sm font-medium disabled:opacity-60"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
