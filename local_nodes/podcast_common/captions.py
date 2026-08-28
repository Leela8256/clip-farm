"""
Caption builders — word-level karaoke captions (ASS, burned in by ffmpeg's
libass) plus SRT / WebVTT sidecars, all generated from the clip's aligned
word timestamps after they've been mapped onto the rendered timeline.

ASS `\\k` tags give each word its own duration so the highlight advances word
by word as it is spoken; the gap to the next word is folded into the current
word's duration to keep the running time in sync with the audio.
"""

from __future__ import annotations

MAX_WORDS_PER_LINE = 4
MAX_LINE_SPAN_MS = 2_500
MAX_GAP_MS = 700

# ASS colours are &HAABBGGRR. Highlight = the studio accent (coral #FF6B4A);
# not-yet-spoken words sit in white.
ACCENT_ASS = '&H004A6BFF'
WHITE_ASS = '&H00FFFFFF'
BLACK_ASS = '&H00000000'
BACK_ASS = '&H80000000'

# Caption geometry per layout: (play_w, play_h, font_size, margin_v). libass
# scales the PlayRes coordinate system to the real frame, so a 540x960
# preview and a 1080x1920 export share one script. The vertical margin keeps
# text clear of the platform UI chrome while staying below the speaker's face.
CAPTION_LAYOUTS = {
    'vertical': (1080, 1920, 64, 520),
    'wide': (1920, 1080, 48, 90),
}


def group_words(
    words: list[dict],
    max_words: int = MAX_WORDS_PER_LINE,
    max_span_ms: int = MAX_LINE_SPAN_MS,
    max_gap_ms: int = MAX_GAP_MS,
) -> list[list[dict]]:
    """Split the word stream into short caption lines on count, span and pauses."""
    groups: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if current:
            span = w['end_ms'] - current[0]['start_ms']
            gap = w['start_ms'] - current[-1]['end_ms']
            if len(current) >= max_words or span > max_span_ms or gap > max_gap_ms:
                groups.append(current)
                current = []
        current.append(w)
    if current:
        groups.append(current)
    return groups


def _ass_time(ms: int) -> str:
    ms = max(0, int(ms))
    cs = (ms % 1000) // 10
    s = ms // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h}:{m:02d}:{sec:02d}.{cs:02d}'


def _srt_time(ms: int, sep: str = ',') -> str:
    ms = max(0, int(ms))
    s, millis = divmod(ms, 1000)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{h:02d}:{m:02d}:{sec:02d}{sep}{millis:03d}'


def _clean(word: str) -> str:
    return word.replace('{', '(').replace('}', ')').replace('\n', ' ').strip()


def build_ass(groups: list[list[dict]], layout: str = 'vertical', font_name: str = 'DejaVu Sans') -> str:
    play_w, play_h, font_size, margin_v = CAPTION_LAYOUTS[layout]
    header = '\n'.join(
        [
            '[Script Info]',
            'ScriptType: v4.00+',
            f'PlayResX: {play_w}',
            f'PlayResY: {play_h}',
            'WrapStyle: 2',
            'ScaledBorderAndShadow: yes',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
            'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, '
            'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            f'Style: Default,{font_name},{font_size},{ACCENT_ASS},{WHITE_ASS},{BLACK_ASS},{BACK_ASS},'
            f'-1,0,0,0,100,100,0,0,1,4,0,2,60,60,{margin_v},1',
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ]
    )
    events = []
    for group in groups:
        line_start = group[0]['start_ms']
        line_end = group[-1]['end_ms']
        parts = []
        for i, w in enumerate(group):
            next_start = group[i + 1]['start_ms'] if i + 1 < len(group) else line_end
            duration_cs = max(1, (next_start - w['start_ms']) // 10)
            parts.append(f"{{\\k{duration_cs}}}{_clean(w['word'])}")
        text = ' '.join(parts)
        events.append(f'Dialogue: 0,{_ass_time(line_start)},{_ass_time(line_end)},Default,,0,0,0,,{text}')
    return header + '\n' + '\n'.join(events) + '\n'


def build_srt(groups: list[list[dict]]) -> str:
    blocks = []
    for i, group in enumerate(groups, start=1):
        text = ' '.join(_clean(w['word']) for w in group)
        blocks.append(f"{i}\n{_srt_time(group[0]['start_ms'])} --> {_srt_time(group[-1]['end_ms'])}\n{text}\n")
    return '\n'.join(blocks)


def build_vtt(groups: list[list[dict]]) -> str:
    blocks = ['WEBVTT', '']
    for group in groups:
        text = ' '.join(_clean(w['word']) for w in group)
        blocks.append(f"{_srt_time(group[0]['start_ms'], '.')} --> {_srt_time(group[-1]['end_ms'], '.')}\n{text}\n")
    return '\n'.join(blocks)
