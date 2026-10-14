"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { readChat, sendChat, type ChatView } from "./actions";

const WHO = { visitor: "You", assistant: "Automated assistant" } as const;

/**
 * THE CHAT ON THE PAGE
 *
 * Asks for the conversation again every few seconds while the page is open, so
 * a reply written in the office's inbox appears here without a reload. A send
 * carries its own key, so a double tap on one bar of signal is one message.
 */
export function PortalChat({ slug, company, initial }: { slug: string; company: string; initial: ChatView }) {
  const [chat, setChat] = useState(initial);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLLIElement>(null);

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
          : `Someone at ${company} will answer here. You can leave this page and come back.`}
      </p>
      <ol aria-label="Messages" className="mt-4 max-h-96 space-y-3 overflow-y-auto">
        {chat.messages.map((message) => (
          <li key={message.id} className={message.from === "visitor" ? "text-right" : ""}>
            <span className="block text-xs text-ink-500">{message.from === "person" ? company : WHO[message.from]}</span>
            <span className={`inline-block max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-left text-sm ${message.from === "visitor" ? "bg-ink-900 text-white" : "bg-steel-100 text-ink-900"}`}>
              {message.text}
            </span>
          </li>
        ))}
        <li ref={end} aria-hidden="true" />
      </ol>
      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const words = text.trim();
          if (words === "") return;
          const key = window.crypto.randomUUID();
          start(async () => {
            const sent = await sendChat(slug, words, key);
            if (!sent.ok) { setError(sent.message); return; }
            setError(null);
            setText("");
            setChat(sent.chat);
          });
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Your message</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000}
                    className="mt-1 block w-full rounded border border-steel-300 bg-canvas p-2 text-sm" />
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
