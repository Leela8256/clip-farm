import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clip Farm",
  description: "Turn a podcast episode into promotional clips — analysed, previewed and exported on RocketRide pipelines.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-20 border-b border-line bg-surface/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-ink-inverse">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M4 6l16-3 1 4-17 3z" />
                  <path d="M10 14v4l4-2z" />
                </svg>
              </span>
              <span className="font-display text-lg font-semibold tracking-[-0.02em]">Clip Farm</span>
              <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint sm:inline">
                on RocketRide
              </span>
            </Link>
            <nav className="flex items-center gap-1 font-mono text-xs uppercase tracking-[0.14em] text-ink-dim">
              <Link href="/" className="rounded-md px-3 py-1.5 transition-colors hover:bg-surface-overlay hover:text-ink">
                Library
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
