"use client";

import { useEffect, useRef, useState } from "react";

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
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [drawn, setDrawn] = useState(false);

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

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  return (
    <div>
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
          setDrawn(true);
        }}
        onPointerUp={() => { drawing.current = false; }}
        onPointerLeave={() => { drawing.current = false; }}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!drawn || pending}
          onClick={() => canvas.current && onSign(canvas.current.toDataURL("image/png"))}
          className="inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Signing" : "Sign"}
        </button>
        <button
          type="button"
          disabled={!drawn || pending}
          onClick={() => {
            const element = canvas.current;
            element?.getContext("2d")?.clearRect(0, 0, element.width, element.height);
            setDrawn(false);
          }}
          className="inline-flex h-10 items-center rounded border border-steel-300 px-4 text-sm font-medium disabled:opacity-60"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
