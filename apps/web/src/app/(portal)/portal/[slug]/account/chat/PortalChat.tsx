"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { readChat, sendChat, type ChatView } from "./actions";

const WHO = { visitor: "You", assistant: "Automated assistant" } as const;

/**
 * THE CHAT ON THE PAGE
 *
 * Asks for the conversation again every few seconds while the page is open, so
 * a reply written in the office's inbox appears here without a reload (and
 * counts as read: the office does not text or email about an answer the
 * customer is looking at). A send carries its own key, so a double tap on one
 * bar of signal is one message. Pictures go with the words, up to three.
 */
export function PortalChat({ slug, company, initial }: { slug: string; company: string; initial: ChatView }) {
  const [chat, setChat] = useState(initial);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLLIElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState(0);
  const pictureHref = (messageId: string, index: number) =>
    `/portal/${encodeURIComponent(slug)}/account/chat/pictures/${messageId}/${index}`;

  useEffect(() => {
    const timer = window.setInterval(() => {
      readChat(slug).then(setChat).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [slug]);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [chat.messages.length]);

  return (
    <section aria-label="Your chat" className="rounded-md border border-steel-200 bg-canvas p-5">
      <p className="text-sm text-ink-700">
        {chat.assistant && chat.status !== "handed_off"
          ? `${company}'s automated assistant answers first. Ask for a person at any time.`
          : `Someone at ${company} will answer here. You can leave this page and come back. We will tell you by email or text when we answer.`}
      </p>
      <ol aria-label="Messages" className="mt-4 max-h-96 space-y-3 overflow-y-auto">
        {chat.messages.map((message) => (
          <li key={message.id} className={message.from === "visitor" ? "text-right" : ""}>
            <span className="block text-xs text-ink-500">{message.from === "person" ? company : WHO[message.from]}</span>
            {message.text !== "" && (
              <span className={`inline-block max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-left text-sm ${message.from === "visitor" ? "bg-ink-900 text-white" : "bg-steel-100 text-ink-900"}`}>
                {message.text}
              </span>
            )}
            {message.pictures.map((picture) => (
              <a key={picture.index} href={pictureHref(message.id, picture.index)} target="_blank" rel="noreferrer"
                 className="mt-1 block text-sm">
                {picture.shown ? (
                  <img src={pictureHref(message.id, picture.index)}
                       alt={message.from === "visitor" ? "Picture you sent" : `Picture from ${company}`}
                       className={`inline-block max-h-48 rounded border border-steel-200 ${message.from === "visitor" ? "" : "bg-steel-100"}`} />
                ) : (
                  <span className="underline underline-offset-4">Open the photo{picture.name ? ` (${picture.name})` : ""}</span>
                )}
              </a>
            ))}
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const words = text.trim();
          const files = Array.from(picker.current?.files ?? []);
          if (words === "" && files.length === 0) return;
          const form = new FormData();
          form.set("text", words);
          form.set("key", window.crypto.randomUUID());
          for (const file of files) form.append("pictures", file);
          start(async () => {
            const sent = await sendChat(slug, form);
            if (!sent.ok) { setError(sent.message); return; }
            setError(null);
            setText("");
            if (picker.current) picker.current.value = "";
            setChosen(0);
            setChat(sent.chat);
          });
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Your message</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000}
                    className="mt-1 block w-full rounded border border-steel-300 bg-canvas p-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Add photos (up to 3)</span>
          <input ref={picker} type="file" name="pictures" multiple
                 accept="image/jpeg,image/png,image/heic,image/webp"
                 onChange={(e) => setChosen(e.target.files?.length ?? 0)}
                 className="mt-1 block text-sm" />
          <span className="mt-1 block text-xs text-ink-500">
            Photos only, 5 MB together. To send a PDF, use &quot;Send us a photo or a PDF&quot; on your account.
            {chosen > 3 ? " Choose 3 or fewer." : ""}
          </span>
        </label>
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        <button type="submit" disabled={pending}
                className="inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "Sending" : "Send"}
        </button>
      </form>
    </section>
  );
}
