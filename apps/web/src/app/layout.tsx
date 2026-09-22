import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
