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
        <header className="border-b border-line px-6 py-3 flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-accent" />
          <span className="font-mono text-sm tracking-wide text-ink-dim">
            rocketride<span className="text-ink">/podcasts</span>
          </span>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
