// The Keep Lighthouse mark: a tower with a signal-amber light, a band and a
// line of sea. Colours come from the brand roles in src/app/theme.css, so the
// tower turns light in the dark theme. The favicon copy is src/app/icon.svg.
export function BrandMark() {
  return (
    <svg
      className="brand-logo"
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <path className="brand-logo-tower" d="M14.5 6.5A5.5 5 0 0 1 25.5 6.5Z" />
      <rect
        className="brand-logo-light"
        x="15.5"
        y="6"
        width="9"
        height="6.5"
        rx="1"
      />
      <rect
        className="brand-logo-tower"
        x="12.5"
        y="12"
        width="15"
        height="3"
        rx="1.5"
      />
      <path className="brand-logo-tower" d="M15.2 15H24.8L27.5 35.5H12.5Z" />
      <path className="brand-logo-band" d="M14.05 23.5H25.95L26.5 27.5H13.5Z" />
      <rect
        className="brand-logo-sea"
        x="5"
        y="35"
        width="30"
        height="4"
        rx="2"
      />
    </svg>
  );
}
