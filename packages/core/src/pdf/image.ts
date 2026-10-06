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
 * A PNG with transparency or a palette, which is what most logos are, is
 * decoded when the caller hands over a compressor (`ImageCodecs`): its rows
 * unfiltered, a palette looked up, and the transparency written as the
 * image's soft mask, so a logo on a white page has no black box round it.
 * Core imports nothing from Node, so without the codecs it is refused as
 * before.
 *
 * Anything else (sixteen bits, interlaced, a HEIC straight off a phone) is
 * refused by returning null, and the caller prints a line saying the
 * photograph is on the screen copy instead, or leaves a logo off.
 */

export interface PdfImage {
  width: number;
  height: number;
  colorSpace: "DeviceGray" | "DeviceRGB" | "DeviceCMYK";
  filter: "DCTDecode" | "FlateDecode";
  /** Extra entries for the image dictionary: the PNG predictor, or the Adobe CMYK decode. */
  extra: string;
  data: Uint8Array;
  /** The transparency, as a grey image the same size: 0 clear, 255 solid. */
  mask?: PdfImage | undefined;
}

/** Compression, handed in by the caller because core imports nothing from Node. */
export interface ImageCodecs {
  inflate: (bytes: Uint8Array) => Uint8Array;
  deflate: (bytes: Uint8Array) => Uint8Array;
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

function png(bytes: Uint8Array, codecs?: ImageCodecs): PdfImage | null {
  let at = 8;
  let width = 0;
  let height = 0;
  let colors = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
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
      colourType = body[9]!;
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0) return null;
      if (colourType === 0) colors = 1;
      else if (colourType === 2) colors = 3;
      else if (colourType === 3 || colourType === 4 || colourType === 6) {
        if (!codecs) return null;
        colors = colourType === 4 ? 2 : colourType === 6 ? 4 : 1;
      } else return null;
    } else if (type === "PLTE") {
      palette = body.slice();
    } else if (type === "tRNS") {
      transparency = body.slice();
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
  if (colourType === 3 || colourType === 4 || colourType === 6) {
    if (colourType === 3 && !palette) return null;
    return decoded({ width, height, colourType, channels: colors, data, palette, transparency }, codecs!);
  }
  return {
    width, height,
    colorSpace: colors === 1 ? "DeviceGray" : "DeviceRGB",
    filter: "FlateDecode",
    extra: `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`,
    data,
  };
}

/**
 * A palette, grey with alpha, or colour with alpha PNG, decoded: its rows
 * inflated and unfiltered (the five PNG filters, by the bytes per pixel),
 * then split into colour and transparency, each compressed again for the
 * file. A mask that is solid everywhere is left off.
 */
function decoded(
  input: {
    width: number; height: number; colourType: number; channels: number; data: Uint8Array;
    palette: Uint8Array | null; transparency: Uint8Array | null;
  },
  codecs: ImageCodecs,
): PdfImage | null {
  const { width, height, channels } = input;
  let raw: Uint8Array;
  try {
    raw = codecs.inflate(input.data);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = up ? up[x]! : 0;
      const c = up && x >= channels ? up[x - channels]! : 0;
      let value = row[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[x] = value & 255;
    }
  }

  const count = width * height;
  const grey = input.colourType === 4;
  const colour = new Uint8Array(count * (grey ? 1 : 3));
  const alpha = new Uint8Array(count);
  let solid = true;
  for (let i = 0; i < count; i += 1) {
    if (input.colourType === 3) {
      const index = pixels[i]!;
      colour[i * 3] = input.palette![index * 3] ?? 0;
      colour[i * 3 + 1] = input.palette![index * 3 + 1] ?? 0;
      colour[i * 3 + 2] = input.palette![index * 3 + 2] ?? 0;
      alpha[i] = input.transparency?.[index] ?? 255;
    } else if (grey) {
      colour[i] = pixels[i * 2]!;
      alpha[i] = pixels[i * 2 + 1]!;
    } else {
      colour[i * 3] = pixels[i * 4]!;
      colour[i * 3 + 1] = pixels[i * 4 + 1]!;
      colour[i * 3 + 2] = pixels[i * 4 + 2]!;
      alpha[i] = pixels[i * 4 + 3]!;
    }
    if (alpha[i] !== 255) solid = false;
  }
  return {
    width, height,
    colorSpace: grey ? "DeviceGray" : "DeviceRGB",
    filter: "FlateDecode",
    extra: "",
    data: codecs.deflate(colour),
    ...(solid ? {} : {
      mask: {
        width, height, colorSpace: "DeviceGray" as const, filter: "FlateDecode" as const, extra: "",
        data: codecs.deflate(alpha),
      },
    }),
  };
}

/**
 * The photograph or logo as something a page can draw, or null when it is not
 * a kind this can print. With `codecs`, a PNG with transparency or a palette
 * is decoded too; without, it is refused.
 */
export function readImage(bytes: Uint8Array, codecs?: ImageCodecs): PdfImage | null {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return png(bytes, codecs);
  return null;
}

/** The largest size that fits a box and keeps the photograph's shape. */
export function fitWithin(image: Pick<PdfImage, "width" | "height">, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return { width: image.width * scale, height: image.height * scale };
}
