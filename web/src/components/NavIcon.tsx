import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  live: <path d="M13 2 5 13.5h6l-1 8.5 8-11.5h-6l1-8.5Z" strokeLinejoin="round" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.3 2" />
    </>
  ),
  chart: (
    <>
      <line x1="5" y1="19" x2="5" y2="12" />
      <line x1="12" y1="19" x2="12" y2="6" />
      <line x1="19" y1="19" x2="19" y2="14" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <line x1="4" y1="9.5" x2="20" y2="9.5" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </>
  ),
  flow: (
    <>
      <rect x="3" y="9" width="5" height="5" rx="1" />
      <rect x="10.5" y="9" width="5" height="5" rx="1" />
      <rect x="18" y="9" width="3" height="5" rx="1" />
      <line x1="8" y1="11.5" x2="10.5" y2="11.5" />
      <line x1="15.5" y1="11.5" x2="18" y2="11.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3.2M12 17.8V21M21 12h-3.2M6.2 12H3M18.4 5.6l-2.3 2.3M8 14l-2.4 2.4M18.4 18.4l-2.3-2.3M8 10 5.6 7.6" />
    </>
  ),
};

export default function NavIcon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      {PATHS[name]}
    </svg>
  );
}
