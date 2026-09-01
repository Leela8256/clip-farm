"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/** The old History screen is now My Projects — send anyone with the old link there. */
export default function HistoryPage() {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.replace("/projects"), 0);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
      <p className="rr-h3">Taking you to My Projects…</p>
      <Link href="/projects" className="rr-btn rr-btn-primary mt-5">
        Open My Projects
      </Link>
    </div>
  );
}
