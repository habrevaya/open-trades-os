import { audio } from "../audio";

export const dynamic = "force-dynamic";

/** The voicemail the caller left, for the player on the call screen. */
export const GET = (_request: Request, context: { params: Promise<{ id: string }> }) =>
  audio(context, "voicemail");
