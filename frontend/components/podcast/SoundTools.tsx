"use client";

import { useState } from "react";
import { Music, Volume2 } from "lucide-react";
import type { AudioProof } from "@/lib/engine";

/**
 * Sound diagnostics next to the clip player. The rendered files carry a normal
 * AAC track, so when nothing is audible the cause is almost always the browser
 * tab (Chrome remembers "Mute site"), the site's sound permission, or the
 * system output — none of which a <video> element can detect. This gives the
 * user two independent checks: a generated tone (bypasses the video path) and
 * the clip's own audio decoded in the page (proves the file has sound).
 */
export default function SoundTools({ proof, onUnmutePlay }: { proof: AudioProof | null | undefined; onUnmutePlay: () => void }) {
  const [tone, setTone] = useState<"idle" | "playing" | "failed">("idle");

  const playTone = async () => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error("no AudioContext");
      const ctx = new Ctx();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 440;
      gain.gain.value = 0.25;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTone("playing");
      osc.stop(ctx.currentTime + 0.7);
      osc.onended = () => {
        setTone("idle");
        void ctx.close();
      };
    } catch {
      setTone("failed");
    }
  };

  return (
    <div className="mt-2 rounded-md border border-line bg-surface-overlay px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onUnmutePlay}
          className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-[11px] text-ink-inverse"
        >
          <Volume2 className="h-3 w-3 text-accent" /> Play with sound
        </button>
        <button
          type="button"
          onClick={() => void playTone()}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink hover:border-accent hover:text-accent"
        >
          <Music className="h-3 w-3" /> {tone === "playing" ? "playing a test tone…" : tone === "failed" ? "tone blocked" : "Sound check (test tone)"}
        </button>
        <span className="font-mono text-[11px] text-ink-dim">
          {proof === undefined
            ? "checking the clip's audio track…"
            : proof === null
            ? "could not decode the clip's audio in this browser"
            : `clip audio decoded here: peak ${proof.peakDb} dB · ${proof.channels === 2 ? "stereo" : `${proof.channels} ch`} · ${proof.seconds.toFixed(1)}s`}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
        No sound although the level above is normal? The tab or site is muted in your browser (Chrome: right-click the tab →
        &ldquo;Unmute site&rdquo;, or the speaker icon in the address bar), or the system output is routed elsewhere. If the test tone
        is silent too, it&apos;s the browser or the Mac, not the clip.
      </p>
    </div>
  );
}
