import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { UploadFiles } from "@opentradesos/field-client";
import { toHex } from "../lib/bytes";

/**
 * Where photographs and signatures wait to be sent.
 *
 * Copied out of the camera's cache into the app's own documents directory
 * the moment they are taken, because the operating system clears the cache
 * when it likes and a photograph taken in a basement may wait a day for
 * signal. Deleted once the server has them.
 */
function uploadsDirectory(): Directory {
  const directory = new Directory(Paths.document, "uploads");
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

export interface KeptFile {
  localUri: string;
  byteSize: number;
  contentHash: string;
}

/** Hash what is ON DISK, after the copy, so the hash describes the bytes that will be sent. */
async function describe(file: File): Promise<KeptFile> {
  const bytes = await file.bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return { localUri: file.uri, byteSize: bytes.length, contentHash: toHex(new Uint8Array(digest)) };
}

export async function keepPhoto(cameraUri: string, uploadId: string, extension: string): Promise<KeptFile> {
  const target = new File(uploadsDirectory(), `${uploadId}.${extension}`);
  await new File(cameraUri).copy(target);
  return describe(target);
}

export async function keepSignature(base64Png: string, uploadId: string): Promise<KeptFile> {
  const target = new File(uploadsDirectory(), `${uploadId}.png`);
  target.create({ overwrite: true });
  target.write(base64Png, { encoding: "base64" });
  return describe(target);
}

export const uploadFiles: UploadFiles = {
  async read(localUri) {
    const file = new File(localUri);
    if (!file.exists) throw new Error("missing");
    return file.base64();
  },
  async remove(localUri) {
    const file = new File(localUri);
    if (file.exists) file.delete();
  },
};
