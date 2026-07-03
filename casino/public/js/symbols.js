/*
 * Slot symbol graphics — small hand-drawn inline SVGs so the look is
 * consistent on every device (no emoji, no external images).
 * Swap these out later for a proper icon set if wanted.
 */

const SYMBOL_SVG = {
  cherry: `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M33 8c-6 10-14 14-14 26" stroke="#5cbf60" stroke-width="4" stroke-linecap="round"/>
      <path d="M33 8c8 6 10 16 10 24" stroke="#5cbf60" stroke-width="4" stroke-linecap="round"/>
      <path d="M33 8c5-2 10-2 13 1" stroke="#3e9142" stroke-width="4" stroke-linecap="round"/>
      <circle cx="19" cy="42" r="11" fill="#e5484d"/>
      <circle cx="16" cy="39" r="3.5" fill="#ff8a8d" opacity="0.8"/>
      <circle cx="43" cy="40" r="11" fill="#c92a3f"/>
      <circle cx="40" cy="37" r="3.5" fill="#ff8a8d" opacity="0.7"/>
    </svg>`,
  lemon: `
    <svg viewBox="0 0 64 64" fill="none">
      <ellipse cx="32" cy="34" rx="20" ry="15" fill="#f5d90a" transform="rotate(-18 32 34)"/>
      <path d="M14 44c-3-2-4-5-3-7" stroke="#c9b209" stroke-width="3" stroke-linecap="round"/>
      <path d="M50 22c3 1 4 4 4 6" stroke="#c9b209" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="26" cy="29" rx="6" ry="3.5" fill="#fdf3a4" opacity="0.75" transform="rotate(-18 26 29)"/>
    </svg>`,
  bell: `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M32 10c-10 0-15 8-15 17 0 8-3 12-6 15h42c-3-3-6-7-6-15 0-9-5-17-15-17z" fill="#f0b429"/>
      <path d="M32 10c-10 0-15 8-15 17 0 8-3 12-6 15h12C22 30 24 14 32 10z" fill="#ffd873" opacity="0.55"/>
      <rect x="29" y="6" width="6" height="6" rx="3" fill="#f0b429"/>
      <circle cx="32" cy="49" r="5" fill="#d19314"/>
    </svg>`,
  star: `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M32 6l7.6 17.2L58 25.4 44 38l4.2 18.6L32 46.4 15.8 56.6 20 38 6 25.4l18.4-2.2z" fill="#ffd340"/>
      <path d="M32 6l7.6 17.2L58 25.4 32 27z" fill="#fff0b0" opacity="0.5"/>
    </svg>`,
  seven: `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M14 10h36l-4 10H32L22 56H10l10-36h-8z" fill="#f4587a"/>
      <path d="M14 10h36l-2 5H16z" fill="#ff9db4" opacity="0.6"/>
    </svg>`,
  diamond: `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M18 10h28l12 14-26 32L6 24z" fill="#43c3ff"/>
      <path d="M18 10L6 24h20zM46 10l12 14H38z" fill="#8fdcff"/>
      <path d="M26 24h12L32 56z" fill="#1f9fe0"/>
      <path d="M18 10h28l-14 14z" fill="#c9efff" opacity="0.85"/>
    </svg>`,
};

const SYMBOL_NAME = {
  cherry: "Cherry",
  lemon: "Lemon",
  bell: "Bell",
  star: "Star",
  seven: "Seven",
  diamond: "Diamond",
};
