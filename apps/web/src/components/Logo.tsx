/**
 * A locate flag: the marker a utility locator leaves in the ground before
 * anyone digs. Same 24px grid and 2px stroke as the icon set, so the mark and
 * the iconography are one system.
 */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 21V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 4h12l-3.2 4.2L18 12.5H6" fill="#0B57D0" stroke="#0B57D0" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
