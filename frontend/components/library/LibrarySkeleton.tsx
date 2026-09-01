/** Placeholder cards shown while your library is read. */
export default function LibrarySkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {Array.from({ length: cards }, (_, i) => (
        <li key={i} className="rr-card rr-enter overflow-hidden" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="rr-skeleton aspect-video w-full" style={{ borderRadius: 0 }} />
          <div className="space-y-2.5 p-4">
            <div className="rr-skeleton h-4 w-2/3" />
            <div className="rr-skeleton h-3 w-1/2" />
            <div className="rr-skeleton h-8 w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
