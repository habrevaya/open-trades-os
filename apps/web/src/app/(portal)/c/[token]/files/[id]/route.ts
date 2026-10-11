import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { fileResponse } from "../../../../photo-response";

/**
 * ONE FILE THE OFFICE MARKED FOR THE CUSTOMER, THROUGH THE ACCOUNT LINK.
 *
 * Read only. The service checks it is a document on one of this customer's
 * jobs that was marked for them; a bad token, another customer's file, an
 * unmarked one and a photograph are all the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  return fileResponse(await portalAccount.accountFileFor(getDb(), token, id).catch(() => null));
}
