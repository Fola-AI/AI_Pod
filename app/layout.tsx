import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { NavBar } from '@/components/nav-bar';

const geistSans = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'AI Pod',
  description: 'Run automated multi-agent discussions and export clean scripts.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <NavBar />
        <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 py-3 text-[10px] text-muted-foreground">
          build{' '}
          <span className="font-mono">
            {process.env.NEXT_PUBLIC_BUILD_SHA ?? 'dev'}
          </span>
        </footer>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
