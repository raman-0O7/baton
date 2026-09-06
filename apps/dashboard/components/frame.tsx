import Link from 'next/link';
import type { ReactNode } from 'react';

export function Frame({
  children,
  folio,
}: {
  children: ReactNode;
  folio: string;
}) {
  return (
    <main className="shell">
      <div className="baton-line" aria-hidden="true">
        <span />
      </div>
      <header className="masthead">
        <Link className="wordmark" href="/" aria-label="Baton home">
          <BatonMark />
          <span>BATON</span>
        </Link>
        <p className="masthead-note">Portable working memory</p>
        <p className="folio">FOLIO / {folio}</p>
      </header>
      {children}
      <footer className="footer">
        <span>BATON CLOUD</span>
        <span>Context moves. Your thinking stays yours.</span>
      </footer>
    </main>
  );
}

// Pinwheel logomark, recolored from the source's multi-hue palette into Baton's
// ink + orange family: a rotational orange gradient (dark → light) around the
// blades with an ink center for contrast, so it reads as one branded mark on paper.
function BatonMark() {
  return (
    <svg
      className="wordmark-mark"
      viewBox="0 0 40 40"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <g>
        <path
          d="M13.0964 20.3536L17.6262 22.4473L17.046 27.6527L8.94876 36.8282C4.2486 33.8023 0.898178 28.8615 0 23.108L13.0964 20.3536Z"
          fill="#bd3d17"
        />
        <path
          d="M25.183 25.94L31.2414 36.3789C27.992 38.6605 24.0331 40 19.7612 40C18.3744 40 17.0206 39.8587 15.7133 39.59L17.046 27.6527L20.4765 23.7656L25.183 25.94Z"
          fill="#d8481f"
        />
        <path
          d="M39.1022 14.881C39.5332 16.5143 39.763 18.2294 39.763 19.9982C39.763 24.1145 38.5192 27.9403 36.3874 31.1207L25.184 25.9405L22.5551 21.4123L25.8574 17.6692L39.1022 14.881Z"
          fill="#f05a28"
        />
        <path
          d="M20.132 0C26.1505 0.109415 31.5194 2.877 35.1148 7.17842L25.8561 17.6694L20.9792 18.6959L18.519 14.4574L20.132 0Z"
          fill="#f6844f"
        />
        <path
          d="M18.519 14.4574L17.9745 19.3269L13.0991 20.353L0.514709 14.5347C2.09964 8.94044 6.05794 4.3436 11.2327 1.9007L18.519 14.4574Z"
          fill="#171813"
        />
      </g>
    </svg>
  );
}

export function LoadingLedger() {
  return (
    <div className="loading-ledger" role="status" aria-live="polite">
      <span />
      <p>Opening your ledger…</p>
    </div>
  );
}
