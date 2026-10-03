import { NextResponse } from "next/server";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { payerDelivery } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";

/**
 * A PAYER'S OPEN INVOICES, AS A FILE TO DOWNLOAD
 *
 * A POST, never a GET, because exporting records each invoice as delivered:
 * a link prefetcher walking the contract page must not mark a client's
 * invoices as sent. The file is the service's answer, handed back as an
 * attachment; a refusal comes back as plain text with its reason.
 */
export async function POST(request: Request, { params }: { params: Promise<{ customerId: string }> }) {
  const user = await requireSetupUser();
  const { customerId } = await params;
  const form = await request.formData();
  const format = form.get("format");
  try {
    const file = await payerDelivery.exportInvoices({ actor: user.actor, db: getDb() }, {
      customerId,
      ...(format === "csv" || format === "xml" ? { format } : {}),
    });
    return new NextResponse(file.body, {
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return new NextResponse(message, { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
