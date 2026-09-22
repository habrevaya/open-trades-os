/**
 * An isometric box, drawn in line.
 *
 * The same mark as the website, kept in step by hand because the two are
 * separate repositories under different licences and a shared package across
 * that boundary would drag the whole design system with it. If this ever
 * diverges from opentradesos.com, this one is wrong.
 *
 * Geometry: the near corner at (12, 11.5) is where the three visible faces
 * meet, the horizontal runs are the standard two-to-one isometric, and the
 * vertical edge is the same length on all three sides, which is what stops it
 * reading as a flattened hexagon.
 */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3.5 20 7.5v8.5L12 20 4 16V7.5L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* The three edges meeting at the near corner. What reads as depth. */}
      <path
        d="M12 11.5 4 7.5M12 11.5 20 7.5M12 11.5V20"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}
