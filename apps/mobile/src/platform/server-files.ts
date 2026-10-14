import { Directory, File, Paths } from "expo-file-system";
import * as Network from "expo-network";
import * as Sharing from "expo-sharing";
import { fileReadProblem, pdfFileName, type FieldCustomerFile } from "@opentradesos/field-client";

/**
 * FILES THE SERVER HOLDS, READ WITH THIS PHONE'S SIGN IN
 *
 * A photograph is drawn straight from the server by the image component, with the
 * sign in as a header (see `FieldApi.fileRequest`). A PDF cannot be: the phone's
 * PDF reader is another app and cannot be handed a header, so the file is
 * downloaded here, with the header, into the app's cache, and that copy is handed
 * to the share sheet, which offers whatever reads PDFs on the phone.
 *
 * KEPT ONLY IN THE CACHE, AND FORGOTTEN AT SIGN OUT. It is a customer's document
 * and the phone may belong to the next person. The operating system may clear the
 * cache earlier, which only means it is downloaded again.
 */
function downloads(): Directory {
  const directory = new Directory(Paths.cache, "customer-files");
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Download a PDF with the given headers and offer it to the phone's readers. A sentence when it could not be, null when it was. */
export async function openPdf(
  file: FieldCustomerFile, request: { url: string; headers: Record<string, string> },
): Promise<string | null> {
  try {
    // The file's address is its content hash, so a copy already here is the same bytes.
    const target = new File(downloads(), pdfFileName(file));
    const kept = target.exists
      ? target
      : await File.downloadFileAsync(request.url, target, { headers: request.headers, idempotent: true });
    if (!(await Sharing.isAvailableAsync())) return "This phone has nothing that can open a PDF.";
    await Sharing.shareAsync(kept.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf" });
    return null;
  } catch {
    const state = await Network.getNetworkStateAsync().catch(() => null);
    return fileReadProblem(state !== null && state.isInternetReachable === false);
  }
}

/** Delete every downloaded file, at sign out. */
export function forgetDownloads(): void {
  try {
    const directory = new Directory(Paths.cache, "customer-files");
    if (directory.exists) directory.delete();
  } catch {
    // The cache is the operating system's to clear in the end.
  }
}
