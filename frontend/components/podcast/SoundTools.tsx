"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, Music, Volume2, VolumeX } from "lucide-react";
import type { AudioProof } from "@/lib/engine";
import type { RenderReport } from "@/lib/podcast";

const MUTE_HELP =
  "No sound although the level is normal? The tab or the site is muted in your browser (Chrome: right-click the tab → Unmute site, or the speaker icon in the address bar), or the system output goes elsewhere. If the test tone is silent too, it is the browser or the computer, not the clip.";

const fmtLufs = (value: number) => `${value.toFixed(1).replace("-", "−")} LUFS`;

/**
 * One-line sound status next to the player plus two independent checks: a
 * generated test tone (bypasses the video path — proves the browser and the
 * output are audible) and "play with sound" (unmutes inside a user gesture).
 * The rendered files carry a normal stereo track, so silence is almost always
 * a muted tab or the system output; the details live in the tooltip.
 */
export default function SoundTools({
  proof,
  report,
  onUnmutePlay,
}: {
  /** the clip's own audio decoded in the page (undefined = not checked, null = could not decode) */
  proof: AudioProof | null | undefined;
  /** the render being played, or null when the original recording is playing */
  report?: RenderReport | null;
  onUnmutePlay: () => void;
}) {
  const [tone, setTone] = useState<"idle" | "playing" | "played" | "failed">("idle");

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
        setTone("played");
        void ctx.close();
        setTimeout(() => setTone((t) => (t === "played" ? "idle" : t)), 2500);
      };
    } catch {
      setTone("failed");
    }
  };

  let Icon = Volume2;
  let text: string;
  let tint: string;
  let title: string;
  if (!report) {
    text = "original sound";
    tint = "text-ink-faint";
    title = "Playing the recording with its own sound. Render a preview to hear the mastered sound and see the captions.";
  } else if (!report.has_audio) {
    Icon = VolumeX;
    text = "no sound track";
    tint = "text-danger";
    title = "This render has no audio track.";
  } else {
    const parts = [proof && proof.channels !== 2 ? `${proof.channels} ch` : "stereo"];
    if (report.loudness) parts.push(fmtLufs(report.loudness.integrated_lufs));
    if (report.captions) parts.push(`${report.caption_preset ?? ""} captions`.trim());
    text = parts.join(" · ");
    tint = "text-ink-dim";
    title = proof
      ? `Decoded in this browser: peak ${proof.peakDb} dB over ${proof.seconds.toFixed(1)} s. ${MUTE_HELP}`
      : proof === null
      ? `Could not decode the sound in this browser. ${MUTE_HELP}`
      : MUTE_HELP;
  }
  if (tone === "failed") {
    Icon = AlertTriangle;
    tint = "text-processing";
    title = `The test tone was blocked. ${MUTE_HELP}`;
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`flex min-w-0 items-center gap-1.5 ${tint}`} title={title}>
        {tone === "played" ? <Check className="h-3.5 w-3.5 shrink-0 text-ready" /> : <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate font-mono text-[11px]">{tone === "played" ? "tone played" : text}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => void playTone()} className="rr-btn rr-btn-ghost rr-btn-sm" title="Play a short test tone that bypasses the video">
          {tone === "playing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Music className="h-3.5 w-3.5" />}
          {tone === "playing" ? "Playing tone…" : tone === "failed" ? "Tone blocked" : "Sound check"}
        </button>
        <button type="button" onClick={onUnmutePlay} className="rr-btn rr-btn-ghost rr-btn-sm px-2" title="Play with sound" aria-label="Play with sound">
          <Volume2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}
