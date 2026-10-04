import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { restore } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

export const dynamic = "force-dynamic";

/**
 * THE COPY, FROM THE BROWSER TO THIS SERVER'S DISK
 *
 * The file is the request body itself, not a form field, so it streams
 * straight to a temporary file without being parsed or held: a company's copy
 * is gigabytes, and a form parser holds the whole thing in memory before
 * anything sees it. The restore then reads it from disk table by table, and
 * the file is deleted afterwards whatever happened.
 *
 * Not a server action, for the same reason: a server action's body is capped
 * at a few megabytes, which is one photograph.
 *
 * A CUSTOM HEADER IS REQUIRED. The session cookie is already `SameSite=lax`,
 * which keeps another site's form from posting here with it; the header is
 * the second lock, because no plain form can set one, and loading a copy into
 * somebody's company is not a request to accept on one lock.
 */
const MAX_BYTES = Number(process.env["RESTORE_UPLOAD_MAX_BYTES"] || 20 * 1024 * 1024 * 1024);

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (request.headers.get("x-opentradesos-restore") !== "1") {
    return NextResponse.json({ error: "A copy is sent from the restore screen." }, { status: 400 });
  }
  if (!request.body) return NextResponse.json({ error: "Choose the copy to restore." }, { status: 400 });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") !== "0";
  const keepSending = url.searchParams.get("keepSending") === "1";
  const name = (url.searchParams.get("name") ?? "copy").slice(0, 300);

  const folder = await mkdtemp(join(tmpdir(), "opentradesos-upload-"));
  const path = join(folder, "copy");
  try {
    let received = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > MAX_BYTES) {
          done(new Error("That file is larger than this deployment takes as an upload. Put it in a bucket and restore it from there."));
          return;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
        counted, createWriteStream(path),
      );
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 413 });
    }
    if (received === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });

    const result = await restore.restore({ actor: user.actor, db: getDb() }, {
      path, source: "upload", sourceName: name, dryRun, keepSending,
    });
    return NextResponse.json({ runId: result.runId, outcome: result.report.outcome });
  } catch (error) {
    const said = refusalOf(error);
    if (said) return NextResponse.json({ error: said }, { status: 409 });
    throw error;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
