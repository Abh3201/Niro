import type { ReactNode } from "react";

/** 20px line icons. Decorative: the buttons that use them carry the accessible name. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SelectIcon = () => (
  <Icon>
    <path d="M5 3l10 6.5-4.5 1.2L8.4 15z" />
  </Icon>
);

export const HandIcon = () => (
  <Icon>
    <path d="M7 10V4.5a1.2 1.2 0 012.4 0V9m0-5.5a1.2 1.2 0 012.4 0V9m0-4a1.2 1.2 0 012.4 0v5.5m0-3a1.2 1.2 0 012.4 0V12a5 5 0 01-5 5h-1a5 5 0 01-4.3-2.4L4 11.4a1.2 1.2 0 012-1.3L7 11.5" />
  </Icon>
);

export const LaserIcon = () => (
  <Icon>
    <circle cx="14" cy="6" r="2.2" />
    <path d="M12.4 7.6L3.5 16.5" />
    <path d="M6.5 13.5L5 12M9 11l-1.5-1.5" opacity="0.5" />
  </Icon>
);

export const StickyIcon = () => (
  <Icon>
    <path d="M4 4h12v8l-4 4H4z" />
    <path d="M12 16v-4h4" />
  </Icon>
);

export const RectangleIcon = () => (
  <Icon>
    <rect x="3.5" y="5" width="13" height="10" rx="1" />
  </Icon>
);

export const EllipseIcon = () => (
  <Icon>
    <ellipse cx="10" cy="10" rx="6.5" ry="5.5" />
  </Icon>
);

export const LineIcon = () => (
  <Icon>
    <path d="M4 16L16 4" />
  </Icon>
);

export const ArrowIcon = () => (
  <Icon>
    <path d="M4 16L16 4M9 4h7v7" />
  </Icon>
);

export const PenIcon = () => (
  <Icon>
    <path d="M13.5 3.5l3 3L7 16l-4 1 1-4z" />
    <path d="M11.5 5.5l3 3" />
  </Icon>
);

export const FrameIcon = () => (
  <Icon>
    <path d="M6.5 3v14M13.5 3v14M3 6.5h14M3 13.5h14" />
  </Icon>
);

export const TextIcon = () => (
  <Icon>
    <path d="M4.5 5V3.5h11V5M10 3.5v13M7.5 16.5h5" />
  </Icon>
);

export const UndoIcon = () => (
  <Icon>
    <path d="M7 5L3.5 8.5 7 12" />
    <path d="M3.5 8.5H12a4.5 4.5 0 010 9H9" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="M13 5l3.5 3.5L13 12" />
    <path d="M16.5 8.5H8a4.5 4.5 0 000 9h3" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 6h12M8 6V4h4v2m-6 0l.7 10h6.6L14 6" />
  </Icon>
);

export const DuplicateIcon = () => (
  <Icon>
    <rect x="7" y="7" width="9" height="9" rx="1" />
    <path d="M13 7V4H4v9h3" />
  </Icon>
);

export const BringToFrontIcon = () => (
  <Icon>
    <path d="M10 16V4M5.5 8.5L10 4l4.5 4.5" />
    <path d="M4 17h12" />
  </Icon>
);

export const BringForwardIcon = () => (
  <Icon>
    <path d="M10 16V6M6 10l4-4 4 4" />
  </Icon>
);

export const SendBackwardIcon = () => (
  <Icon>
    <path d="M10 4v10M6 10l4 4 4-4" />
  </Icon>
);

export const SendToBackIcon = () => (
  <Icon>
    <path d="M10 4v12M5.5 11.5L10 16l4.5-4.5" />
    <path d="M4 3h12" />
  </Icon>
);

export const GroupIcon = () => (
  <Icon>
    <path d="M3 5.5V3h2.5M14.5 3H17v2.5M17 14.5V17h-2.5M5.5 17H3v-2.5" />
    <rect x="6" y="6" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Icon>
);

export const UngroupIcon = () => (
  <Icon>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </Icon>
);

export const ImageIcon = () => (
  <Icon>
    <rect x="3" y="4" width="14" height="12" rx="1.5" />
    <circle cx="7.5" cy="8" r="1.3" />
    <path d="M3.5 14.5l4-4 3 3 2-2 4 4" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="3.2" />
    <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M16 12.2A6.5 6.5 0 017.8 4a6.5 6.5 0 108.2 8.2z" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 016 0V9" />
  </Icon>
);

export const UnlockIcon = () => (
  <Icon>
    <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 015.6-1.5" />
  </Icon>
);

/** A sample stroke for the line style buttons: dashed or dotted, thin or thick. */
export const StrokeSampleIcon = ({
  dash,
  width = 1.6,
}: {
  dash?: "dashed" | "dotted" | undefined;
  width?: number | undefined;
}) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={width}
    strokeLinecap={dash === "dotted" ? "round" : "butt"}
    strokeDasharray={dash === "dashed" ? "4 3" : dash === "dotted" ? "0.1 3.6" : undefined}
    aria-hidden="true"
  >
    <path d="M2 10h16" />
  </svg>
);

/** A line with a head at one end, both, or neither. */
export const HeadSampleIcon = ({ head }: { head: "none" | "end" | "start" | "both" }) => (
  <Icon>
    <path d="M4 10h12" />
    {(head === "end" || head === "both") && <path d="M12.5 6.5L16 10l-3.5 3.5" />}
    {(head === "start" || head === "both") && <path d="M7.5 6.5L4 10l3.5 3.5" />}
  </Icon>
);

export const CommentIcon = () => (
  <Icon>
    <path d="M4 4.5h12a1 1 0 011 1v7a1 1 0 01-1 1H9l-3.5 3v-3H4a1 1 0 01-1-1v-7a1 1 0 011-1z" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="10" r="0.6" fill="currentColor" />
    <circle cx="10" cy="10" r="0.6" fill="currentColor" />
    <circle cx="15" cy="10" r="0.6" fill="currentColor" />
  </Icon>
);

export const TextFormatIcon = () => (
  <Icon>
    <path d="M3 15l3.5-10 3.5 10M4.3 11.5h4.4" />
    <path d="M13.5 9.5c.4-.6 1-.9 1.8-.9 1.1 0 1.7.6 1.7 1.7V15m0-3.2c-.6-.3-1.2-.4-1.9-.4-1.2 0-2.1.6-2.1 1.8 0 1 .7 1.8 1.8 1.8.9 0 1.6-.5 2.2-1.2" />
  </Icon>
);

export const MapIcon = () => (
  <Icon>
    <path d="M3 5.5l4-1.5 6 2 4-1.5v10l-4 1.5-6-2-4 1.5z" />
    <path d="M7 4v10M13 6v10" />
  </Icon>
);

/** A straight or an elbowed arrow, for the route buttons. */
export const RouteSampleIcon = ({ route }: { route: "straight" | "elbow" }) => (
  <Icon>
    {route === "straight" ? (
      <path d="M4 15L16 5M12.5 5H16v3.5" />
    ) : (
      <path d="M4 15h6V5h6M13 2.5L16 5l-3 2.5" />
    )}
  </Icon>
);

/** Lines of text set left, centered or right, for the alignment buttons. */
export const AlignIcon = ({ align }: { align: "left" | "center" | "right" }) => {
  const short =
    align === "left" ? "M4 9h8M4 15h8" : align === "right" ? "M8 9h8M8 15h8" : "M6 9h8M6 15h8";
  return (
    <Icon>
      <path d={`M4 6h12M4 12h12${short}`} />
    </Icon>
  );
};

/** A box with its text at the top, middle or bottom, for the vertical alignment buttons. */
export const VerticalAlignIcon = ({ valign }: { valign: "top" | "middle" | "bottom" }) => {
  const y = valign === "top" ? 6.5 : valign === "bottom" ? 13.5 : 10;
  return (
    <Icon>
      <rect x="3.5" y="3.5" width="13" height="13" rx="1.5" opacity="0.5" />
      <path d={`M7 ${y - 1.25}h6M7 ${y + 1.25}h6`} />
    </Icon>
  );
};
