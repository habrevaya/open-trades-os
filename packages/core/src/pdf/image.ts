/**
 * A PHOTOGRAPH ON A PAGE, WITHOUT AN IMAGE LIBRARY
 *
 * A proposal's cover and its options carry photographs, and the PDF has to
 * print them. PDF can take two common formats almost as they are, which is
 * why this is a few dozen lines rather than a decoder:
 *
 *   A JPEG is handed over whole, filtered `DCTDecode`. Every reader decodes
 *   it; all this file reads from it is its size and how many colour
 *   channels it has, from the frame header.
 *
 *   A PNG whose pixels are plain grey or colour (no transparency, no
 *   palette, eight bits, not interlaced) is its compressed data handed over
 *   filtered `FlateDecode` with the PNG predictor, which is the same
 *   compression and the same per row filters PNG itself uses.
 *
 * Anything else (a PNG with transparency, a palette, sixteen bits, a HEIC
 * straight off a phone) is refused by returning null, and the caller prints
 * a line saying the photograph is on the screen copy instead. Decoding and
 * flattening transparency is real work, and doing it badly prints a black
 * box where somebody's kitchen should be.
 */

export interface PdfImage {
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB" | "DeviceCMYK";
  filter: "DCTDecode" | "FlateDecode";
  /** Extra entries for the image dictionary: the PNG predictor, or the Adobe CMYK decode. */
  extra: string;
  data: Uint8Array;
}

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

/** The start-of-frame markers that carry a JPEG's size: every SOFn but the three that are something else. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(bytes: Uint8Array): PdfImage | null {
  let at = 2;
  let adobe = false;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes and the markers with no length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (marker === 0xee && String.fromCharCode(...bytes.subarray(at + 4, at + 9)) === "Adobe") adobe = true;
    if (SOF.has(marker)) {
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      const components = bytes[at + 9];
      if (!width || !height) return null;
      const colorSpace = components === 1 ? "DeviceGray" : components === 3 ? "DeviceRGB" : components === 4 ? "DeviceCMYK" : null;
      if (!colorSpace) return null;
      return {
        width, height, colorSpace, filter: "DCTDecode",
        /**
         * Photoshop writes CMYK JPEGs with every channel inverted and says so
         * in an APP14 "Adobe" marker; without the decode array they print as
         * a negative.
         */
        extra: colorSpace === "DeviceCMYK" && adobe ? "/Decode [1 0 1 0 1 0 1 0]" : "",
        data: bytes,
      };
    }
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

function png(bytes: Uint8Array): PdfImage | null {
  let at = 8;
  let width = 0;
  let height = 0;
  let colors = 0;
  const parts: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (at + 12 + length > bytes.length) return null;
    if (type === "IHDR") {
      width = u32(body, 0);
      height = u32(body, 4);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0) return null;
      if (colourType === 0) colors = 1;
      else if (colourType === 2) colors = 3;
      else return null;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height || !colors || parts.length === 0) return null;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return {
    width, height,
    colorSpace: colors === 1 ? "DeviceGray" : "DeviceRGB",
    filter: "FlateDecode",
    extra: `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`,
    data,
  };
}

/** The photograph as something a page can draw, or null when it is not a kind this can print. */
export function readImage(bytes: Uint8Array): PdfImage | null {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return png(bytes);
  return null;
}

/** The largest size that fits a box and keeps the photograph's shape. */
export function fitWithin(image: Pick<PdfImage, "width" | "height">, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return { width: image.width * scale, height: image.height * scale };
}
