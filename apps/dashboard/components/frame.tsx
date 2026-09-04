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
          <span className="wordmark-mark">B</span>
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

export function LoadingLedger() {
  return (
    <div className="loading-ledger" role="status" aria-live="polite">
      <span />
      <p>Opening your ledger…</p>
    </div>
  );
}
