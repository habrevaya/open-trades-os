/**
 * Ask the field assistant and read its answer as it is written, from
 * `/my-day/ask` (see the route for the shape of each line). `onWriting` is
 * handed the answer so far each time it grows; the promise is the whole
 * answer, after its checks, or the reason there is none. A dropped signal
 * rejects, as the server action it replaces did.
 */
export type AskResult =
  | { ok: true; answered: boolean; text: string; sources: Array<{ kind: string; title: string }> }
  | { ok: false; message: string };

export async function askAsItWrites(
  input: { question: string; visitId: string | null }, onWriting: (text: string) => void,
): Promise<AskResult> {
  const response = await fetch("/my-day/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opentradesos-ask": "1" },
    body: JSON.stringify({ question: input.question, visitId: input.visitId }),
  });
  if (!response.ok || !response.body) {
    const said = await response.json().catch(() => null) as { problem?: string } | null;
    return { ok: false, message: said?.problem ?? "The assistant could not answer. Try again, or ask the office." };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AskResult | null = null;
  const read = (line: string) => {
    if (!line.trim()) return;
    const piece = JSON.parse(line) as {
      writing?: string; problem?: string;
      answer?: { answered: boolean; text: string; sources: Array<{ kind: string; title: string }> };
    };
    if (typeof piece.writing === "string") onWriting(piece.writing);
    if (piece.answer) result = { ok: true, ...piece.answer };
    if (typeof piece.problem === "string") result = { ok: false, message: piece.problem };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      read(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  }
  read(buffer + decoder.decode());
  /** The connection ended before the answer: the same as no signal. */
  if (!result) throw new Error("The answer did not arrive.");
  return result;
}
