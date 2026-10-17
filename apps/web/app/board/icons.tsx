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
