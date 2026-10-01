export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that runs a model somewhere else, on its own hardware or
 * behind a regional provider its regulator will accept, can drop this barrel
 * and import `./provider` plus its own adapter: nothing in the call path
 * names Anthropic, OpenAI or Google.
 *
 * All three are imported here rather than one, because unlike a merchant
 * account or a carrier, a company genuinely does hold keys for several of
 * these at once and chooses per call which one is worth the money.
 */
import "./anthropic";
import "./openai";
import "./google";
