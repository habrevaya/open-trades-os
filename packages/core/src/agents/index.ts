/**
 * M27, THE AGENTS
 *
 * What each agent may do (`catalogue`), how a company has set it up
 * (`settings`), what it is told (`prompts`), and what its answers are held to
 * before anything reads them (`schema`, `guardrails`). Pure, so every rule an
 * agent runs under can be tested without a model or a database.
 */
export * from "./catalogue.js";
export * from "./settings.js";
export * from "./guardrails.js";
export * from "./prompts.js";
export * from "./widget.js";
export { check as checkAgainstSchema, unsupportedKeywords, type JsonSchema, type Checked } from "./schema.js";
