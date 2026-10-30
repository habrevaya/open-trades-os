import { describe, it, expect } from "vitest";
import {
  CHAT_PICTURES, checkChatPicture, chatReplyMessage, readPortalSettings, chatIdleCloseProblem,
} from "../src/customer-portal/index.js";

/**
 * THE CHAT FROM A CUSTOMER'S ACCOUNT: THE NOTICE AND THE PICTURES
 *
 * The notice names the company and gives the link and never the reply, because
 * a text sits on a lock screen. The pictures are held to the customer upload
 * rules with three limits of the chat's own, and decided by their bytes.
 */

const jpeg = (size = 100) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(size).fill(1)]);
const room = { filesInMessage: 0, bytesInMessage: 0, bytesToday: 0 };

describe("the notice that the office answered", () => {
  const words = chatReplyMessage({ companyName: "Cedar Heating", customerName: "Dana Cedar", url: "https://x.test/portal/cedar/account/chat" });

  it("fits in a text and carries the link", () => {
    expect(words.text).toBe("Hi Dana, Cedar Heating answered your message. Read it and reply here: https://x.test/portal/cedar/account/chat");
    expect(words.text.length).toBeLessThan(160);
    expect(words.subject).toBe("Cedar Heating answered your message");
    expect(words.email).toContain("https://x.test/portal/cedar/account/chat");
  });

  it("uses no dashes, and still reads when there is no name", () => {
    expect(`${words.subject}${words.text}${words.email}`).not.toMatch(new RegExp("[\\u2013\\u2014]"));
    const nameless = chatReplyMessage({ companyName: "", customerName: " ", url: "https://x.test/c" });
    expect(nameless.text).toBe("Hi, Your service company answered your message. Read it and reply here: https://x.test/c");
  });
});

describe("the setting", () => {
  it("is on unless somebody turned it off", () => {
    expect(readPortalSettings(undefined).chatReplyNotice).toBe(true);
    expect(readPortalSettings({ chatReplyNotice: "no" }).chatReplyNotice).toBe(true);
    expect(readPortalSettings({ chatReplyNotice: false }).chatReplyNotice).toBe(false);
  });
});

describe("a picture in the chat", () => {
  it("is a photo by its bytes", () => {
    const verdict = checkChatPicture({ fileName: "leak.jpg", bytes: jpeg() }, room);
    expect(verdict).toMatchObject({ ok: true, contentType: "image/jpeg", extension: "jpg" });
  });

  it("is never a program, whatever it is called or says it is", () => {
    const exe = checkChatPicture({ fileName: "leak.jpg", bytes: new Uint8Array([0x4d, 0x5a, 1, 2, 3, 4]) }, room);
    expect(exe).toMatchObject({ ok: false, reason: expect.stringMatching(/program or a script/) });
    const named = checkChatPicture({ fileName: "leak.exe", bytes: jpeg() }, room);
    expect(named.ok).toBe(false);
    const claimed = checkChatPicture({ fileName: "leak", contentType: "text/html", bytes: jpeg() }, room);
    expect(claimed.ok).toBe(false);
  });

  it("is not a PDF, a GIF or something that is not a picture", () => {
    const pdf = checkChatPicture({ fileName: "scan.pdf", bytes: new TextEncoder().encode("%PDF-1.4 hello") }, room);
    expect(pdf).toMatchObject({ ok: false, reason: expect.stringContaining("PDF goes through") });
    const gif = checkChatPicture({ fileName: "a.gif", bytes: new TextEncoder().encode("GIF89a....") }, room);
    expect(gif.ok).toBe(false);
    const text = checkChatPicture({ fileName: "a.jpg", bytes: new TextEncoder().encode("hello there") }, room);
    expect(text.ok).toBe(false);
  });

  it("is held to three in a message, five megabytes in a message and a day's total", () => {
    expect(checkChatPicture({ fileName: "d.jpg", bytes: jpeg() }, { ...room, filesInMessage: CHAT_PICTURES.maxPerMessage }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("up to 3 pictures") });
    expect(checkChatPicture({ fileName: "d.jpg", bytes: jpeg() }, { ...room, bytesInMessage: CHAT_PICTURES.maxMessageBytes - 10 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("one message can come to 5 MB") });
    expect(checkChatPicture({ fileName: "d.jpg", bytes: jpeg() }, { ...room, bytesToday: CHAT_PICTURES.maxBytesPerDay - 10 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("today") });
    expect(checkChatPicture({ fileName: "d.jpg", bytes: jpeg() }, { ...room, bytesToday: 1000 }).ok).toBe(true);
  });

  it("draws what a browser draws and offers the rest to open", () => {
    expect(CHAT_PICTURES.shownInPage).toContain("image/jpeg");
    expect(CHAT_PICTURES.shownInPage).not.toContain("image/heic");
    expect(CHAT_PICTURES.types).toContain("image/heic");
  });
});

describe("closing a quiet chat", () => {
  it("is off until the company chooses a number of days", () => {
    expect(readPortalSettings(undefined).chatIdleCloseDays).toBeNull();
    expect(readPortalSettings({ chatIdleCloseDays: 7 }).chatIdleCloseDays).toBe(7);
    for (const bad of [0, 91, 2.5, "7", null, true]) {
      expect(readPortalSettings({ chatIdleCloseDays: bad }).chatIdleCloseDays).toBeNull();
    }
  });

  it("refuses anything but a whole number of days from one to ninety, or off", () => {
    expect(chatIdleCloseProblem(null)).toBeNull();
    expect(chatIdleCloseProblem(1)).toBeNull();
    expect(chatIdleCloseProblem(90)).toBeNull();
    for (const bad of [0, -3, 91, 1.5, "3", undefined, Number.NaN]) {
      expect(chatIdleCloseProblem(bad)).toMatch(/whole number from 1 to 90/);
    }
  });
});
