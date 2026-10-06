export * from "./provider";
export { exchangeCode, tokenSource, parseOAuthClient, type OAuthClient, type Grant } from "./oauth";
export { seal, unseal, sealingKey, SEALING_KEY_ENV, SealingKeyMissingError, SealedUnderAnotherKeyError } from "./sealing";
export { customerDigits } from "./google-ads";
export { verifyMetaSignature, leadFromMeta, META_SIGNATURE_HEADER } from "./meta-lead-ads";
export { firstCsvIn } from "./zip";

/**
 * Adapters register themselves on import, the same arrangement as every other
 * seam: a deployment that writes its own for a regional platform imports
 * `./provider` and theirs, and nothing in the services names any of these.
 */
import "./google-ads";
import "./meta-ads";
import "./ga4";
import "./google-business-profile";
import "./microsoft-ads";
import "./meta-lead-ads";
import "./search-console";
import "./ga4-data";
import "./facebook-page";
