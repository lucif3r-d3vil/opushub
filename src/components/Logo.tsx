// The OpusHub mark — one shape, used by the rail, the login screen and the setup wizard.
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      <path d="M32 8 54 20v24L32 56 10 44V20z" stroke="var(--ink)" strokeWidth="3.2" strokeLinejoin="round" />
      <circle cx="32" cy="32" r="6.5" fill="var(--accent)" />
    </svg>
  );
}
