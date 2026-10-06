import type { transcript } from "@opentradesos/core";
import type { VoiceResult } from "./provider";
import { adapterSettings } from "../secrets/endpoints";

/**
 * THE SPEECH TO TEXT SEAM
 *
 * What this product needs from whoever turns a call's audio into words: hand
 * over the bytes, get back segments with offsets and a confidence. Nothing
 * about what happens to the words is the provider's business. Malformed
 * output is refused, card numbers are destroyed before the first write, and
 * a low confidence transcript is marked as one, all by core's `transcript`
 * module on our side of the seam, so changing provider changes none of it.
 *
 * Every call returns a result rather than throwing for the provider saying
 * no, because "the server is busy, try later" and "that file is not audio"
 * are different answers, and only the first is worth asking again.
 */

export interface AudioToTranscribe {
  bytes: Uint8Array;
  contentType: string;
  /** A name with the right extension. Some servers read the format from it rather than from the bytes. */
  fileName: string;
  /**
   * The speaker label every segment carries. A voicemail is one person, the
   * caller. A recorded call is two people mixed onto one track, and a model
   * that cannot tell voices apart must not be made to pretend it can.
   */
  speaker: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: AudioToTranscribe): Promise<VoiceResult<{
    /** Raw, as the provider shaped it into our fields. Checked by core before anything is stored. */
    segments: transcript.RawSegment[];
    language: string | null;
  }>>;
}

export class TranscriptionNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No speech to text provider called "${provider}".`);
    this.name = "TranscriptionNotConfiguredError";
  }
}

type Factory = (settings: Record<string, unknown>, secret: string) => TranscriptionProvider;
const registry = new Map<string, Factory>();

/** Registered rather than imported, the same as every other adapter seam here. */
export function registerTranscriptionProvider(name: string, factory: Factory): void {
  registry.set(name, factory);
}

export function createTranscriptionProvider(
  name: string, settings: Record<string, unknown>, secret: string,
): TranscriptionProvider {
  const factory = registry.get(name);
  if (!factory) throw new TranscriptionNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`. The API key and
  // the call's audio would both go wherever one pointed.
  return factory(adapterSettings(name, settings), secret);
}

export const transcriptionProviders = (): string[] => [...registry.keys()];
