import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mocap Studio — video to BVH',
  description: 'Upload a video or paste a link, get a BVH motion file. A Notion-style motion workspace built on mocap-ts.',
  applicationName: 'Mocap Studio',
  authors: [{ name: 'mocap-ts' }],
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-surface text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
