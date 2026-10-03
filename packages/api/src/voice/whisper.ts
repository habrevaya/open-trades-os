import type { transcript } from "@opentradesos/core";
import { registerTranscriptionProvider, type TranscriptionProvider } from "./transcription";

/**
 * SPEECH TO TEXT, OVER THE WHISPER API
 *
 * The audio transcription endpoint OpenAI publishes, which is also what the
 * self hosted Whisper servers speak (faster-whisper-server, LocalAI, the
 * whisper.cpp server). A company that does not want its customers' calls to
 * leave the building points `endpoint` at a box in its own office, with no
 * key at all, and nothing else changes.
 *
 * Written against the HTTP API directly, like every other adapter, so a self
 * hoster can read the one request that carries a customer's voice off their
 * network.
 */

interface Settings {
  /** Where the API lives, up to and including `/v1`. OpenAI's when absent. */
  endpoint?: string;
  /** The model to ask for. `whisper-1` on OpenAI; a self hosted server names its own. */
  model?: string;
  /** The language spoken, as a two letter code, when it is always the same. Left to the model when absent. */
  language?: string;
  /** Override for testing. Never set in production. */
  baseUrl?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * One of Whisper's segments, as its verbose JSON writes it.
 *
 * `avg_logprob` is the model's own confidence, as a log probability; its
 * exponent is a probability between 0 and 1, which is the scale core
 * checks. `no_speech_prob` is the model's estimate that the stretch was not
 * speech at all.
 */
interface WhisperSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/**
 * Whisper's own rule for a stretch of silence: likely not speech AND said
 * with little confidence. The model is known to write a stock phrase ("thank
 * you for watching") over silence, and those stretches are dropped here by
 * the thresholds Whisper itself uses to decide the same thing, rather than
 * stored as words a customer never said.
 */
const silence = (segment: WhisperSegment) =>
  (segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1;

/**
 * Whisper's segments in our fields.
 *
 * Offsets are FLOORED to the millisecond rather than rounded, both of them,
 * so two segments that touch in the model's seconds still touch here: a
 * rounded end can land a millisecond past the next start, and core refuses
 * overlapping segments, rightly. A confidence the model did not give is left
 * absent so core refuses it rather than this guessing one.
 */
export function segmentsFromWhisper(payload: Record<string, unknown>, speaker: string): transcript.RawSegment[] {
  const segments = Array.isArray(payload["segments"]) ? payload["segments"] as WhisperSegment[] : [];
  return segments
    .filter((segment) => typeof segment.text === "string" && segment.text.trim() !== "" && !silence(segment))
    .map((segment) => ({
      speaker,
      startMs: typeof segment.start === "number" ? Math.floor(segment.start * 1000) : null,
      endMs: typeof segment.end === "number" ? Math.floor(segment.end * 1000) : null,
      text: segment.text!.trim(),
      confidence: typeof segment.avg_logprob === "number" ? Math.min(1, Math.exp(segment.avg_logprob)) : null,
    }));
}

export function createWhisperTranscription(
  settings: Record<string, unknown>,
  apiKey: string,
  transport: Fetch = (url, init) => fetch(url, init),
): TranscriptionProvider {
  const config = settings as Settings;
  const base = (config.baseUrl ?? config.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = config.model?.trim() || "whisper-1";

  return {
    name: "whisper",

    async transcribe(audio) {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }), audio.fileName);
      form.set("model", model);
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      if (config.language?.trim()) form.set("language", config.language.trim());

      let response: Response;
      try {
        response = await transport(`${base}/audio/transcriptions`, {
          method: "POST",
          /** No key for a server in the office that takes none, rather than an empty bearer it might refuse. */
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          body: form,
        });
      } catch (error) {
        return {
          ok: false, code: "network", retryable: true,
          message: `The speech to text server could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || !payload) {
        const error = payload?.["error"] as Record<string, unknown> | undefined;
        return {
          ok: false,
          code: String(error?.["code"] ?? response.status),
          retryable: retryable(response.status),
          message: String(error?.["message"] ?? `The speech to text server answered ${response.status}.`),
        };
      }

      return {
        ok: true,
        segments: segmentsFromWhisper(payload, audio.speaker),
        language: typeof payload["language"] === "string" ? payload["language"] : null,
      };
    },
  };
}

registerTranscriptionProvider("whisper", createWhisperTranscription);
