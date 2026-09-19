// Minimal hand-written single-stroke icons (Phosphor-style). No emoji.
interface P {
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export const EnvelopeIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </svg>
);

export const PenIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" />
    <path d="M14.5 6.5l3 3" />
  </svg>
);

export const CheckIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);

export const XIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const UnlinkIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M9 15l-2.5 2.5a3.5 3.5 0 01-5-5L4 10" />
    <path d="M15 9l2.5-2.5a3.5 3.5 0 015 5L20 14" />
    <path d="M4 4l16 16" />
  </svg>
);

export const InboxIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M3 13l2.5-8h13L21 13v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6z" />
    <path d="M3 13h5l1.5 2h5L16 13h5" />
  </svg>
);
