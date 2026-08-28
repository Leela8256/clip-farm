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


def align_words(path: str | Path, model_name: str = 'small', language: str | None = 'en', hint: str | None = None) -> dict:
    """Words with millisecond timings relative to the start of the given audio file."""
    model = get_model(model_name)
    with _lock:
        segments, info = model.transcribe(
            str(path),
            word_timestamps=True,
            vad_filter=False,
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
    return {'language': info.language, 'words': words, 'text': ' '.join(text)}
