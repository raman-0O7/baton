import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

export const metadata: Metadata = {
  title: 'Baton — Your working memory',
  description: 'Manage the devices connected to your Baton working memory.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="paper-noise" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
