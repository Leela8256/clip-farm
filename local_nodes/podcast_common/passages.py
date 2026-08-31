"""
Transcript passages for the semantic index.

The stock embedding + vector-store nodes index whatever documents they are
given; the LLM only ever sees a document's page_content (metadata is not
rendered into the prompt). So every passage is a self-describing block of
timestamped sentence lines — the same `[mm:ss - mm:ss] text` format the
discovery prompt understands — and the metadata carries the episode id as
objectId (one upsert per episode, one filter key per search) plus the
passage's absolute times for anyone reading the index directly.
"""

from __future__ import annotations

from .clips import fmt_timestamp

WINDOW_MS = 60_000
STEP_MS = 30_000
MIN_WINDOW_MS = 12_000
EMBED_MODEL_HINT = 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1'


def window_passages(sentences: list[dict], window_ms: int = WINDOW_MS, step_ms: int = STEP_MS) -> list[dict]:
    """
    Overlapping, sentence-aligned windows over the transcript. Each passage is
    `window_ms` long (measured from its first sentence), the next one starts
    `step_ms` later, so a moment straddling a boundary is whole in one of
    them. A short trailing window is folded into the previous passage.
    """
    ordered = [s for s in sorted(sentences, key=lambda s: s['start_ms']) if (s.get('text') or '').strip()]
    if not ordered:
        return []
    passages: list[dict] = []
    cursor = ordered[0]['start_ms']
    last_end = ordered[-1]['end_ms']
    while cursor < last_end:
        part = [s for s in ordered if cursor <= s['start_ms'] < cursor + window_ms]
        if part:
            passages.append({'sentences': part, 'start_ms': part[0]['start_ms'], 'end_ms': part[-1]['end_ms']})
        cursor += step_ms
    # fold a short tail into its predecessor, drop exact duplicates of the previous window
    cleaned: list[dict] = []
    for p in passages:
        if cleaned and (p['end_ms'] - p['start_ms'] < MIN_WINDOW_MS or p['sentences'] == cleaned[-1]['sentences']):
            prev = cleaned[-1]
            seen = {s['id'] for s in prev['sentences']}
            prev['sentences'] = prev['sentences'] + [s for s in p['sentences'] if s['id'] not in seen]
            prev['end_ms'] = max(prev['end_ms'], p['end_ms'])
            continue
        cleaned.append(p)
    for i, p in enumerate(cleaned):
        p['index'] = i
        p['text'] = passage_text(p['sentences'])
        p['sentence_ids'] = [s['id'] for s in p['sentences']]
        del p['sentences']
    return cleaned


def passage_text(sentences: list[dict]) -> str:
    return '\n'.join(f"[{fmt_timestamp(s['start_ms'])} - {fmt_timestamp(s['end_ms'])}] {(s.get('text') or '').strip()}"
                     for s in sentences if (s.get('text') or '').strip())


def passage_documents(passages: list[dict], episode_id: str, project_root: str, node_id: str = 'podcast_segment') -> list:
    """Engine Doc objects for the embedding node (imported lazily: nodes only)."""
    from ai.common.schema import Doc, DocMetadata

    docs = []
    for p in passages:
        metadata = DocMetadata(objectId=episode_id, chunkId=int(p['index']), nodeId=node_id, parent=project_root,
                               permissionId=0, isDeleted=False, isTable=False, tableId=0,
                               start_ms=int(p['start_ms']), end_ms=int(p['end_ms']), episode_id=episode_id,
                               sentence_ids=list(p.get('sentence_ids') or []))
        docs.append(Doc(page_content=p['text'], metadata=metadata))
    return docs


def merge_regions(hits: list[dict], sentences: list[dict], pad_ms: int = 20_000) -> list[dict]:
    """
    Turn retrieved passages (start_ms/end_ms/score) into non-overlapping,
    context-padded regions of the transcript, best score first. Used by the
    full-transcript fallback and for explaining what the model was shown.
    """
    if not hits:
        return []
    spans = sorted(((max(0, h['start_ms'] - pad_ms), h['end_ms'] + pad_ms, float(h.get('score') or 0)) for h in hits), key=lambda x: x[0])
    merged: list[list] = []
    for start, end, score in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
            merged[-1][2] = max(merged[-1][2], score)
        else:
            merged.append([start, end, score])
    regions = []
    for start, end, score in merged:
        part = [s for s in sentences if s['start_ms'] < end and s['end_ms'] > start]
        if part:
            regions.append({'start_ms': part[0]['start_ms'], 'end_ms': part[-1]['end_ms'], 'score': round(score, 3), 'text': passage_text(part)})
    regions.sort(key=lambda r: -r['score'])
    return regions
