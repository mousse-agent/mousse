import logoOutlineSvg from "../../../../assets/mousse_logo_icon_outline.svg?raw";

/**
 * The outline Mousse logo's strokes, read once from the asset. Drawn at a tool row's 18px they are scaled up so the
 * line is about as heavy as the other row icons' 1.5px-in-24 strokes.
 */
const STROKE_SCALE = 2.6;
const LOGO_PATHS = [...logoOutlineSvg.matchAll(/<path d="([^"]+)"[^>]*stroke-width="([\d.]+)"/g)].map(([, d, width]) => ({
  d: d!,
  width: Number(width) * STROKE_SCALE,
}));

/** The icon of Mousse's own tools in a tool row: the outline logo, in the row's colour. */
export function MousseToolIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="-24 -24 562 562"
      fill="none"
      aria-hidden="true"
      data-icon="mousse"
    >
      {LOGO_PATHS.map((path, index) => (
        <path
          key={index}
          d={path.d}
          stroke="currentColor"
          strokeWidth={path.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
