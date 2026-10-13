"use client";

import { useState, type ChangeEvent } from "react";

/**
 * THE FILE BOX, MAKING A BIG PHOTOGRAPH SMALL ENOUGH TO SEND
 *
 * A phone camera's picture can be over the five megabytes a file may be,
 * and the form would then fail on the way to the server with nothing a
 * customer could act on. A photograph over the limit is made smaller here,
 * in the browser, the way the technician's day does it (longest side 2000
 * pixels, a JPEG), and put back in the box before the form is sent. A PDF,
 * or a picture the browser cannot read, is left as it is and the server
 * says if it is too big.
 */
const LONGEST_SIDE = 2000;

async function smaller(file: File): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob || blob.size >= file.size) return null;
    const stem = file.name.replace(/\.[^.]*$/, "") || "photo";
    return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  }
}

export function FileInput({ maxBytes }: { maxBytes: number }) {
  const [note, setNote] = useState<string | null>(null);

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    setNote(null);
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || file.size <= maxBytes || !file.type.startsWith("image/")) return;
    setNote("Making the photo smaller to send.");
    const made = await smaller(file);
    if (!made || made.size > maxBytes || typeof DataTransfer === "undefined") {
      setNote("That photo is too big to send. Try a smaller one.");
      return;
    }
    const swap = new DataTransfer();
    swap.items.add(made);
    input.files = swap.files;
    setNote(null);
  }

  return (
    <label className="block">
      <span className="text-sm font-medium text-ink-700">A photo or a PDF</span>
      <input
        type="file" name="file" required onChange={onChange}
        accept="image/jpeg,image/png,image/heic,image/webp,application/pdf"
        className="mt-1 block text-sm"
      />
      {note ? <span role="status" className="mt-1 block text-xs text-ink-500">{note}</span> : null}
    </label>
  );
}
