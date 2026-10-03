import { audio } from "../audio";

export const dynamic = "force-dynamic";

/** The call's kept recording, for the player on the call screen. */
export const GET = (_request: Request, context: { params: Promise<{ id: string }> }) =>
  audio(context, "recording");
