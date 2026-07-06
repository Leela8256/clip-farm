import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RocketRide Podcasts",
  description: "AI podcast audio editing — auto-pilot and chat modes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          <div className="h-2 w-2 rounded-full bg-accent shadow-glow-accent" />
          <span className="font-mono text-xs uppercase tracking-[0.14em] text-ink-faint">
            rocketride<span className="text-ink-dim">/podcasts</span>
          </span>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
