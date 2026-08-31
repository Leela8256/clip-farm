"""
Word-level alignment for one clip with the engine's bundled faster-whisper.
The stock audio_transcribe node gives sentence timestamps for the whole
episode; captions need word timing, so each clip's short interval is
re-transcribed with word_timestamps on. The model is loaded once per engine
process and shared behind a lock (CTranslate2 models are not thread-safe).
"""

from __future__ import annotations
import threading
from pathlib import Path

_lock = threading.Lock()
_models: dict[str, object] = {}


def get_model(name: str = 'small'):
    with _lock:
        model = _models.get(name)
        if model is None:
            from faster_whisper import WhisperModel

            model = WhisperModel(name, device='auto', compute_type='int8')
            _models[name] = model
        return model


# Bumped whenever the alignment quality changes (model, VAD, sanitizer) so
# stored timelines can announce that re-preparing an episode would improve them.
ALIGN_VERSION = 2

MAX_WORD_MS = 1500        # no spoken word is longer; anything above is timing smear
SMEAR_PROB = 0.2          # ...and a long word with this little confidence is a hallucination
SMEAR_MS = 1200


def sanitize_words(words: list[dict]) -> list[dict]:
    """
    Whisper stretches uncertain words across leading silence or music (a word
    "spanning" 8 s at probability 0.01), which threw captions out of sync for
    the first seconds of a piece. Rules: drop long near-zero-confidence words,
    cap a word's duration by pulling its START toward its end (ends line up
    with the next word and are the trustworthy edge), and never let a word
    overlap its successor.
    """
    out: list[dict] = []
    for w in words:
        start, end = int(w['start_ms']), int(w['end_ms'])
        if end <= start:
            continue
        prob = float(w.get('probability', 1.0) or 0.0)
        if end - start > SMEAR_MS and prob < SMEAR_PROB:
            continue
        if end - start > MAX_WORD_MS:
            start = end - MAX_WORD_MS
        out.append({**w, 'start_ms': start, 'end_ms': end})
    for i in range(len(out) - 1):
        if out[i]['end_ms'] > out[i + 1]['start_ms']:
            out[i]['end_ms'] = max(out[i]['start_ms'] + 1, out[i + 1]['start_ms'])
    return out


def align_words(path: str | Path, model_name: str = 'small', language: str | None = 'en', hint: str | None = None) -> dict:
    """Words with millisecond timings relative to the start of the given audio file."""
    model = get_model(model_name)
    with _lock:
        segments, info = model.transcribe(
            str(path),
            word_timestamps=True,
            # VAD keeps the model from timing words across leading/trailing
            # silence or music — the cause of out-of-sync opening captions
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': 300},
            language=language or None,
            initial_prompt=(hint or '')[:200] or None,
            condition_on_previous_text=False,
        )
        words, text = [], []
        for seg in segments:
            text.append(seg.text.strip())
            for w in seg.words or []:
                word = w.word.strip()
                if word:
                    words.append({'word': word, 'start_ms': int(w.start * 1000), 'end_ms': int(w.end * 1000),
                                  'probability': round(float(w.probability), 3)})
    return {'language': info.language, 'words': sanitize_words(words), 'text': ' '.join(text)}
