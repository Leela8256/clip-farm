import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import Sidebar from "@/components/shell/Sidebar";
import Toasts from "@/components/shell/Toasts";

export const metadata: Metadata = {
  title: "Clip Farm",
  description: "Turn a podcast episode into short clips: find the moments, frame them, ship them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <Suspense fallback={<aside className="w-[232px] shrink-0 border-r border-line bg-surface-raised/80" />}>
            <Sidebar />
          </Suspense>
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-[1240px] px-6 py-8 lg:px-10">{children}</div>
          </main>
        </div>
        <Toasts />
      </body>
    </html>
  );
}
