export * from "./provider";
export {
  callRailProvider, verifyCallRailWebhook, callRailSignature,
  SIGNATURE_HEADER, MAX_SKEW_MS,
} from "./callrail";

/**
 * Imported for the side effect of registering itself, exactly as the
 * messaging, payment and email barrels do. A deployment using a different
 * tracking vendor drops this barrel and registers its own adapter; nothing
 * in the intake path names CallRail.
 */
import "./callrail";
