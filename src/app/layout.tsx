import type { Metadata, Viewport } from 'next';
import './globals.css';

// Everything a bystander (or the OS app switcher / home screen) can see must look like a plain calculator.
export const metadata: Metadata = {
  title: 'Web Browser',
  description: 'A fast and simple web browser',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.png',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'Browser',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-white text-slate-900 antialiased selection:bg-indigo-500 selection:text-white">
        <main className="mobile-app-shell">{children}</main>
      </body>
    </html>
  );
}
