/**
 * The episode the "Clip Studio" nav item opens: the last one the producer
 * looked at, kept in localStorage (per browser, best effort).
 */

const KEY = "clipfarm.recent";

export interface RecentEpisode {
  id: string;
  title: string;
  at: number;
}

export function rememberEpisode(id: string, title: string): void {
  try {
    const list = recentEpisodes().filter((e) => e.id !== id);
    list.unshift({ id, title, at: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));
    window.dispatchEvent(new Event("clipfarm:recent"));
  } catch {
    /* private mode or storage disabled */
  }
}

export function recentEpisodes(): RecentEpisode[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentEpisode[]) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string") : [];
  } catch {
    return [];
  }
}

export function subscribeRecent(fn: () => void): () => void {
  window.addEventListener("clipfarm:recent", fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener("clipfarm:recent", fn);
    window.removeEventListener("storage", fn);
  };
}
