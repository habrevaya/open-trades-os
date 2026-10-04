import { adapterSettings } from "../secrets/endpoints";

/**
 * THE VOICE SEAM
 *
 * What this product needs from a carrier to run a tracking number itself:
 * find a number, buy it pointed at our webhooks, hand it back, fetch a
 * recording the recording check allowed and delete the carrier's copy, and
 * prove a webhook came from the carrier. Nothing about routing or consent is
 * the carrier's business; both are decided here and handed over as
 * instructions.
 *
 * Every call returns a result rather than throwing for the carrier saying no,
 * because "that number was bought by somebody else a second ago" is an answer
 * the settings screen shows, not a crash.
 */

export type VoiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; retryable: boolean };

export interface AvailableNumber {
  e164: string;
  /** As the carrier writes it, for the list somebody picks from. */
  friendlyName: string;
  locality: string | null;
  region: string | null;
}

export interface WebhookRequest {
  /** The public URL the carrier was given, including any query string. */
  url: string;
  headers: Record<string, string>;
  /** The raw form body, exactly as received. */
  body: string;
}

export interface NumberWebhooks {
  /** Where the carrier asks what to do with a call. */
  voiceUrl: string;
  /** Where it reports how a call ended. */
  statusUrl: string;
  /** Where texts to the number go: the ordinary messaging webhook. */
  smsUrl: string;
}

export interface VoiceProvider {
  readonly name: string;
  /** Whether this request genuinely came from the carrier. Never optional. */
  verify(request: WebhookRequest): boolean;
  searchNumbers(query: {
    areaCode?: string | undefined; locality?: string | undefined; region?: string | undefined; limit: number;
  }): Promise<VoiceResult<{ numbers: AvailableNumber[] }>>;
  buyNumber(input: { e164: string; webhooks: NumberWebhooks; label?: string | undefined }):
    Promise<VoiceResult<{ providerNumberId: string; e164: string }>>;
  /** Point a number the account already holds at our webhooks. */
  configureNumber(input: { providerNumberId: string; webhooks: NumberWebhooks }): Promise<VoiceResult<object>>;
  /**
   * A number the account already holds, with where its calls go now.
   * `found: false` when the account does not hold it, which is an answer
   * rather than a failure: the number may be with another carrier.
   */
  findNumber(e164: string): Promise<VoiceResult<
    | { found: true; providerNumberId: string; voiceUrl: string | null; statusUrl: string | null }
    | { found: false }
  >>;
  /**
   * Point only a number's CALLS somewhere: here when it is adopted, and back
   * where they were when it stops being answered here. Texts are left
   * alone, because a number adopted for its calls may have its texts
   * answered by something else entirely.
   */
  pointCalls(input: { providerNumberId: string; voiceUrl: string; statusUrl: string }): Promise<VoiceResult<object>>;
  releaseNumber(providerNumberId: string): Promise<VoiceResult<object>>;
  /**
   * Ring a phone or a browser from one of the company's numbers, and ask
   * `url` what to do when it is answered. Used to offer a waiting caller to
   * the people who answer their line.
   */
  placeCall(input: {
    to: string; from: string; url: string; timeoutSeconds: number;
  }): Promise<VoiceResult<{ callSid: string }>>;
  /**
   * Start recording a call already in progress. Only ever called after the
   * recording check said yes for it: on a call the office placed from the
   * browser, that is after the person called pressed 1.
   */
  startRecording(input: { callSid: string; recordingCallback: string }): Promise<VoiceResult<object>>;
  /**
   * Create, or point again, the carrier's application that the browser phone
   * places its calls through. Its voice address is where the carrier asks
   * what to do with a call a person dials in the office app.
   */
  saveApplication(input: {
    applicationSid: string | null; label: string; voiceUrl: string; statusUrl: string;
  }): Promise<VoiceResult<{ applicationSid: string }>>;
  fetchRecording(recordingUrl: string): Promise<VoiceResult<{ bytes: Uint8Array }>>;
  deleteRecording(recordingId: string): Promise<VoiceResult<object>>;
}

export class VoiceProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`No voice provider for "${provider}". Calls are routed only through a connected Twilio account.`);
    this.name = "VoiceProviderNotConfiguredError";
  }
}

type Factory = (settings: Record<string, unknown>, secret: string) => VoiceProvider;
const registry = new Map<string, Factory>();

/** Registered rather than imported, the same as every other adapter seam here. */
export function registerVoiceProvider(name: string, factory: Factory): void {
  registry.set(name, factory);
}

export function createVoiceProvider(name: string, settings: Record<string, unknown>, secret: string): VoiceProvider {
  const factory = registry.get(name);
  if (!factory) throw new VoiceProviderNotConfiguredError(name);
  // Never a stored endpoint override: see `adapterSettings`. Without this a
  // connection's `baseUrl` would receive the account's auth token.
  return factory(adapterSettings(name, settings), secret);
}

export const voiceCapableProviders = (): string[] => [...registry.keys()];
