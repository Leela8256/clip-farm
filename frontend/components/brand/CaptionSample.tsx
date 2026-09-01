"use client";

import { useEffect, useRef, useState } from "react";
import { captionCss, captionHighlightCss, resolveCaptionStyle, type CaptionStyle } from "@/lib/brand";

/**
 * The caption style stores its size against a 1080-wide frame, and captionCss
 * draws at `basePx` for a size of 44. Dividing the frame's real width by this
 * keeps the sample the same fraction of the picture as the finished clip.
 */
const WIDTH_PER_BASE_PX = 1080 / 44;

const DEFAULT_TEXT = "This is exactly how your captions will look";

const clean = (w: string) => w.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase();

/** Split the sample sentence the way the style groups spoken words. */
function toLines(text: string, maxWords: number, maxLines: number): string[][] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (let i = 0; i < words.length && out.length < maxLines; i += maxWords) out.push(words.slice(i, i + maxWords));
  return out.length ? out : [["Captions"]];
}

/**
 * A live sample of a caption look, drawn with the same CSS the designer
 * previews with. It is a fair likeness of the finished clip, not the render.
 */
export default function CaptionSample({
  style,
  text = DEFAULT_TEXT,
  portrait = false,
  animate = true,
  className = "",
}: {
  style: CaptionStyle | string;
  text?: string;
  portrait?: boolean;
  animate?: boolean;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = requestAnimationFrame(() => setWidth(el.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const s = resolveCaptionStyle(style);
  const off = s.preset === "none" || s.preset === "off";
  const karaoke = s.karaoke !== false;

  useEffect(() => {
    if (!animate || !karaoke || off) return;
    const timer = setInterval(() => setBeat((b) => b + 1), 560);
    return () => clearInterval(timer);
  }, [animate, karaoke, off]);

  const maxWords = Math.max(1, s.max_words ?? 4);
  const maxLines = s.max_lines === 2 ? 2 : 1;
  const rows = toLines(s.case === "upper" ? text.toUpperCase() : text, maxWords, maxLines);
  const total = rows.reduce((n, r) => n + r.length, 0);
  const spoken = karaoke && animate ? beat % (total + 2) : total;
  const keywords = new Set((s.keywords ?? []).map(clean));

  const base = width ? captionCss(s, { basePx: width / WIDTH_PER_BASE_PX }) : { opacity: 0 };
  const highlight = captionHighlightCss(s);
  const position = s.position ?? "bottom";
  const alignment = s.alignment ?? "center";
  const pad = Math.max(6, width * 0.06);

  let index = -1;

  return (
    <div
      ref={frame}
      className={`relative overflow-hidden rounded-[10px] ${className}`}
      style={{
        aspectRatio: portrait ? "9 / 16" : "16 / 9",
        background: "linear-gradient(155deg, #332C26 0%, #15120F 55%, #241C17 100%)",
      }}
      aria-hidden="true"
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: position === "top" ? "flex-start" : position === "middle" ? "center" : "flex-end",
          alignItems: alignment === "left" ? "flex-start" : "center",
          padding: `${pad}px ${pad}px ${position === "bottom" ? pad * (portrait ? 2.4 : 1.2) : pad}px`,
          gap: Math.max(2, width * 0.008),
        }}
      >
        {off ? (
          <p style={{ margin: 0, color: "rgba(255,255,255,0.35)", fontSize: Math.max(9, width * 0.035), textAlign: "center" }}>No words on screen</p>
        ) : (
          rows.map((row, r) => (
            <p
              key={r}
              style={{
                ...base,
                margin: 0,
                display: "inline-block",
                maxWidth: "100%",
                ...(s.box ? { padding: `${Math.max(1, width * 0.006)}px ${Math.max(3, width * 0.02)}px` } : null),
                ...(s.speaker_colors && r === 1 ? highlight : null),
              }}
            >
              {row.map((word, w) => {
                index += 1;
                const isKeyword = keywords.has(clean(word));
                const lit = isKeyword || (karaoke && index < spoken);
                const pop = s.emphasis && index === spoken - 1;
                return (
                  <span
                    key={`${r}-${w}`}
                    style={{
                      ...(lit ? highlight : null),
                      display: "inline-block",
                      transform: pop ? "scale(1.09)" : undefined,
                      transition: "transform 150ms ease-out",
                      marginRight: "0.3em",
                    }}
                  >
                    {word}
                  </span>
                );
              })}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
