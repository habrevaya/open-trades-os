import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentField } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

export const dynamic = "force-dynamic";

/**
 * THE FIELD ASSISTANT, ANSWERING AS IT WRITES
 *
 * A question from `/my-day`, answered as the person asking, with the answer
 * sent as it is written: one line of JSON per piece, `{"writing": ...}` with
 * the answer so far (whole sentences, each naming only amounts in the
 * records), then one `{"answer": ...}` with the whole answer after its checks,
 * or `{"problem": ...}`. The screen shows the pieces and then puts the whole
 * answer in their place, which may say the answer cannot be shown.
 *
 * Not a server action, because an action answers once; a response body can
 * be read as it arrives. A custom header is required, as on the restore
 * upload: the session cookie is `SameSite=lax`, and no plain form can set a
 * header, so another site cannot spend the company's model budget with it.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ problem: "Sign in first." }, { status: 401 });
  if (request.headers.get("x-opentradesos-ask") !== "1") {
    return NextResponse.json({ problem: "Questions are asked from your day." }, { status: 400 });
  }
  const body = await request.json().catch(() => null) as { question?: unknown; visitId?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 1000) : "";
  const visitId = typeof body?.visitId === "string" && /^[0-9a-f-]{36}$/i.test(body.visitId) ? body.visitId : null;
  if (question.length < 3) return NextResponse.json({ problem: "Ask a question first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      try {
        const answer = await agentField.ask(
          { actor: user.actor, db: getDb() },
          { question, ...(visitId ? { visitId } : {}) },
          undefined,
          (text) => line({ writing: text }),
        );
        line({ answer });
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) console.error("field assistant failed", error);
        line({ problem: refusal ?? "The assistant could not answer. Try again, or ask the office." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      /** Proxies that buffer a response would hold every piece until the end. */
      "X-Accel-Buffering": "no",
    },
  });
}
