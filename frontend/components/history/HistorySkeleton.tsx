/** Placeholder rows shown while the list of runs is read from your library. */
export default function HistorySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="rr-enter rr-card flex items-center gap-4 p-3 pr-4" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="rr-skeleton h-[54px] w-24 shrink-0" style={{ borderRadius: 8 }} />
          <div className="flex-1 space-y-2.5">
            <div className="rr-skeleton h-3.5 w-1/3" />
            <div className="rr-skeleton h-3 w-2/3" />
          </div>
          <div className="rr-skeleton h-6 w-28" style={{ borderRadius: 999 }} />
        </li>
      ))}
    </ul>
  );
}
