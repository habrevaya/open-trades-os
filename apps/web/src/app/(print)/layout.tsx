/**
 * PAGES MEANT FOR PAPER
 *
 * No navigation rail, no header, nothing that prints as a grey band down the
 * left of an owner's bank meeting handout. The page itself says whose it is
 * and what it is, and carries its own way back for the screen.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-4xl bg-canvas px-6 py-8 text-ink-900 print:max-w-none print:px-0 print:py-0">
      {children}
    </main>
  );
}
