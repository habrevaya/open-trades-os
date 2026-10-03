import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { HeldSubmits } from "@/components/HeldSubmits";
import { HELD_SUBMITS_SCRIPT } from "@/lib/held-submits";
import { HYDRATE_AFTER_PARSE_SCRIPT } from "@/lib/hydrate-after-parse";

/**
 * Plex rather than Inter. Squared terminals read as instrument panel rather
 * than as startup, the x-height holds at 14px on a phone in sun, and 1/l and
 * 0/O are unambiguous, which matters when a job number is read aloud over a
 * phone. SIL OFL licensed, which matters for an open source product.
 */
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "OpenTradesOS", template: "%s | OpenTradesOS" },
  description: "The open source operating system for home services companies.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/*
          A plain script in the head, so it runs while the page is still
          arriving, before anything can be pressed; see lib/held-submits.ts.
          Not next/script's beforeInteractive: that queues it until Next's own
          code has loaded, which is after a quick thumb, and holds hydration
          back while it runs.
        */}
        <script dangerouslySetInnerHTML={{ __html: HELD_SUBMITS_SCRIPT }} />
        {/* React starts once the page is all here; see lib/hydrate-after-parse.ts. */}
        <script dangerouslySetInnerHTML={{ __html: HYDRATE_AFTER_PARSE_SCRIPT }} />
      </head>
      <body>
        {children}
        <HeldSubmits />
      </body>
    </html>
  );
}
