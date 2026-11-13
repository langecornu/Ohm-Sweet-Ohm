/**
 * The Ohm Sweet Ohm mark: a peaked roofline sitting over an Ω (omega, the
 * unit of resistance) drawn as a rounded archway — "home" and "ohm" in one
 * shape, the pun the name is built on. Monoline, single currentColor
 * stroke, so it just inherits whatever text color it's placed in and needs
 * no separate light/dark asset files (unlike a filled/multi-tone mark).
 */
export default function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Ohm Sweet Ohm"
      role="img"
    >
      {/* roof */}
      <path d="M6 12 L16 4 L26 12" />
      {/* omega archway (home + ohm) */}
      <path d="M9 26.5 L6.5 27.5 M9 26.5 L9 17.5 A7 7 0 0 1 23 17.5 L23 26.5 M23 26.5 L25.5 27.5" />
      {/* spark, echoing the roof peak */}
      <circle cx="25.5" cy="6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="27.5" cy="9" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
