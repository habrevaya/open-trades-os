import { describe, it, expect } from "vitest";
import { syncLine, type SyncState } from "../src/lib/status";
import { dayHeading, photoSummary, telUrl } from "../src/lib/format";
import { extensionFor, pngFromDataUrl, toHex } from "../src/lib/bytes";
import { SIGNATURE_PAD_HTML } from "../src/lib/signature-pad";

/**
 * The words and decisions on the screens, without the screens.
 *
 * The status line is the most looked at sentence in the app: it is how a
 * technician knows whether the office has their work. Each of its states is
 * pinned here.
 */

const base: SyncState = {
  waiting: 0, uploadsWaiting: 0, problems: 0, syncing: false, offline: false, signedOut: false,
  backoffUntil: null, lastSyncedAt: null,
};
const now = new Date("2026-10-02T15:00:00Z");
const zone = "America/Chicago";

describe("the line under the date", () => {
  it("says all sent, and when", () => {
    expect(syncLine({ ...base, lastSyncedAt: "2026-10-02T14:58:00Z" }, zone, now))
      .toEqual({ text: "All sent, 2 min ago", tone: "ok" });
    expect(syncLine(base, zone, now)).toEqual({ text: "All sent", tone: "ok" });
  });

  it("counts what is waiting, updates and photos apart", () => {
    expect(syncLine({ ...base, waiting: 3, uploadsWaiting: 1 }, zone, now))
      .toEqual({ text: "3 updates and 1 photo waiting to send", tone: "waiting" });
    expect(syncLine({ ...base, waiting: 1 }, zone, now).text).toBe("1 update waiting to send");
  });

  it("says there is no signal and when it will try again", () => {
    expect(syncLine({
      ...base, waiting: 2, offline: true, backoffUntil: new Date("2026-10-02T15:05:00Z"),
    }, zone, now)).toEqual({ text: "No signal. 2 updates waiting to send, trying again at 10:05 AM", tone: "waiting" });
  });

  it("says it is sending while it sends", () => {
    expect(syncLine({ ...base, waiting: 2, syncing: true }, zone, now).text).toBe("Sending 2 updates");
  });

  it("puts a sign in that ended above everything else", () => {
    expect(syncLine({ ...base, waiting: 2, signedOut: true }, zone, now).tone).toBe("problem");
  });

  it("asks for a look when there are problems and nothing else", () => {
    expect(syncLine({ ...base, problems: 1 }, zone, now)).toEqual({ text: "1 thing needs a look", tone: "problem" });
  });
});

describe("small things the screens rely on", () => {
  it("names the day without slipping a day west of the server", () => {
    expect(dayHeading("2026-10-02")).toBe("Friday, Oct 2");
  });

  it("dials a number and not a blank", () => {
    expect(telUrl("(512) 555-0140")).toBe("tel:5125550140");
    expect(telUrl("+1 512 555 0140")).toBe("tel:+15125550140");
    expect(telUrl(null)).toBeNull();
    expect(telUrl("ext")).toBeNull();
  });

  it("counts photos in words", () => {
    expect(photoSummary({ waiting: 0, sent: 0, failed: 0 })).toBe("No photos taken on this phone yet.");
    expect(photoSummary({ waiting: 1, sent: 2, failed: 1 }))
      .toBe("Taken on this phone: 2 sent, 1 waiting to send, 1 could not be sent.");
  });

  it("writes a hash the way the server does", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("takes a PNG signature out of a data URL, and nothing else", () => {
    expect(pngFromDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
    expect(pngFromDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(pngFromDataUrl("empty")).toBeNull();
  });

  it("keeps a camera file under the type it is", () => {
    expect(extensionFor("image/jpeg")).toEqual({ extension: "jpg", contentType: "image/jpeg" });
    expect(extensionFor("image/heic")).toEqual({ extension: "heic", contentType: "image/heic" });
    expect(extensionFor(undefined)).toEqual({ extension: "jpg", contentType: "image/jpeg" });
  });

  it("has a signature pad that says when it is drawn on and hands back a PNG", () => {
    expect(SIGNATURE_PAD_HTML).toContain('post("drawn")');
    expect(SIGNATURE_PAD_HTML).toContain('toDataURL("image/png")');
    expect(SIGNATURE_PAD_HTML).toContain("window.signatureSave");
  });
});
