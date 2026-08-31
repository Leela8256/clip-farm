# RocketRide stock node catalog — what the podcast app can build on

Compiled from `rocketride-server` (`develop`, 2026-08-28) by reading every
`nodes/src/nodes/<name>/services*.json` + `IInstance.py`. It exists so each
phase of the podcast roadmap starts from stock nodes and only adds a custom
node when nothing in the catalog does the job. Lane notation: `in → out`.

## Rules of the engine worth knowing before wiring anything

- **Questions carry everything.** A `Question` has `role`, `instructions`, `examples`,
  `context`, `goals`, `documents`, `filter` (a `DocFilter`: `objectIds`, `parent`, `name`,
  `limit`, chunk ranges…) and `expectJson`. `llm_*` nodes flatten it into one prompt
  (`Question.getPrompt()`); document **metadata never reaches the model** — only
  `page_content` — so timestamps must be inlined in the text.
- **Stores search by the question's filter** and, with a `questions` listener, forward the
  *same* Question with `documents` filled in and `filter.objectIds` narrowed
  (`DocumentStoreBase.dispatchSearch`). That is how `embedding → store → llm` chains keep
  the client's instructions intact. The `prompt` node instead *rebuilds* a Question from its
  own `instructions` and drops `expectJson` / `role` / `filter`.
- **Every stock vector store needs a server** (`qdrant`, `chroma` = HTTP client only,
  `postgres`+pgvector, `milvus`, `weaviate`, `pinecone`, `astra`, `atlas`, `elasticsearch`);
  `rocketride_vector` / `rocketride_sql` / `rocketride_graph` need the RocketRide cloud
  identity (per-tenant DSN). None runs in-process.
- **`expectJson`** = prompt-and-reparse with 3 repair retries; streaming is off for it.
  There is no tool-use / JSON-schema mode on `llm_anthropic`, no system-prompt field, no
  temperature field (only `llm_ollama` exposes temperature).
- `answers` are terminal: nothing stock turns an `answers` lane back into `questions`. Two
  LLM stages therefore need two pipeline calls (or a custom bridge node).
- Media lanes stream `BEGIN/WRITE/END`; `BEGIN` carries a descriptor, and the engine stamps
  `metadata.source.stream_index` per stream.
- Tools (`tool_*`, `memory_*`, `db_*` as tools) have no lanes: they bind to an agent's
  `invoke.tool` channel. `tool_pipe` exposes an inline sub-pipeline as an agent tool.

## Nodes by podcast phase

| Phase | Stock nodes that fit | Verdict |
| --- | --- | --- |
| 1 Prompt Director | `chat`, `llm_anthropic` (parse + discovery + revisions), `embedding_transformer` (local, no key), `qdrant`/`chroma`/`store_postgres`/`rocketride_vector` (per-episode filter via `objectIds`), `response_answers` / `response_documents`, optional `rerank_cohere` (Cohere key) | Built on stock nodes; the podcast-specific glue stays in the existing custom nodes (`podcast_segment` emits passages, `podcast_refine` enforces constraints, `podcast_prepare_clip` fits duration / plans cuts). |
| 2 Smart Visual Director | `frame_grabber` (video → frames + `time_stamp`, `interval` / `transition` / `key` profiles; the `table` lane gives ordinal → seconds), `pose_estimation` (RTMPose, 17 keypoints — **the detector in use**: nose/eyes/ears → face box), `face_detection` (BlazeFace — **unavailable on release engines**, it carries the `debug` capability), `detect` (RF-DETR / Grounding-DINO people), `detect_segment` (masks), `background_removal`, `llm_vision_*` (per-frame description, keeps `time_stamp`; needs a vision-LLM key), `twelvelabs` (whole-video analysis, API key), `embedding_video` (frame embeddings) | Detection is stock (`clip-preview` / `clip-export` / `visual-scan` pipes); `podcast_layout` turns per-frame people into a smoothed, dwell-limited layout plan and `podcast_render` renders the crops (no stock node reframes video). `podcast_visual` is the episode scan. |
| 3 Brand Studio / clip editor | `caption` (image captioning, *not* subtitles), `thumbnail` (128 px only), `video_composer` (frames → mp4 only: no trims, audio, overlays), `audio_tts` / `cloud_tts` (VO), `tool_deepl` (caption translation) | Rendering stays custom (ffmpeg in `podcast_render`); brand templates are data, not nodes. |
| 4 Transcript editor | `audio_transcribe` (sentences + `time_stamp`), `anonymize` (PII scrub before publishing), `guardrails` | Editing math (keep segments, EDL validation, cut safety) is already in `podcast_common/editing.py`; the full-episode render reuses the clip renderer. |
| 5 Content packs / archive | `summarization` (summary + key points + entities, invoke LLM), `preprocessor_llm` (semantic chunks + summary chunk), `ner`, `dictionary` (glossary), `answer_documents` (LLM answer → indexable documents), `extract_data` / `extract_facts` (typed tables with provenance), `embedding_transformer` + a store for cross-episode search (filter by `parent` prefix), `db_postgres` / `rocketride_sql` (NL→SQL over a clips table), `graph_*` (episode/guest/topic graph), `llm_perplexity` / `search_exa` / `tool_tavily` (context enrichment) | Mostly stock. |
| 6 Collaboration / publishing | `tool_n8n` (webhooks, uploads), `tool_slack` (review channel), `tool_http_request` (any API), `webhook` / `telegram` sources, `tool_filesystem` (account store as tool + sink with signed URLs), `memory_persistent` (preferences across sessions) | Stock, behind an agent (`agent_rocketride` needs a `memory_*` node). |
| 7 VOD ingestion | `webhook` (file / URL intake), `tool_http_request`, `tool_daytona` (yt-dlp/ffmpeg in a sandbox) | Stock. |

## Node-by-node summary

Legend: **key** = needs an API key / external service; **local** = runs on the engine.

### Sources, outputs, plumbing
| Node | Lanes | Notes |
| --- | --- | --- |
| `chat` / `webhook` / `dropper` / `tools` (webhook dir) | `_source → questions` / `tags,text,json,audio,video,image,questions` | The app's front door; `client.chat()` for chat, `send_files()` for webhook/dropper. |
| `telegram` | `_source → text,image,audio,video,tags` | Bot source; replies with `answers[0]`. |
| `response_*` | `answers`/`documents`/`questions`/`text`/`table`/`json`/`audio`/`video`/`image → –` | `result_types` names each key; `response_questions` dumps the whole Question (debugging). |
| `question` | `text → questions` | Wraps text; no template. |
| `prompt` | `questions,documents,text,table → questions` | Merges inputs + its `instructions` into a *new* Question in `closing()`. |
| `local_text_output` / `text_output` | `text → –` | Disk / SMB sinks (`nosaas`). |
| `remote` | transport | Runs lanes on another engine. |
| `tool_pipe` | `_source → text,questions,documents,table,answers` | Sub-pipeline as an agent tool; nesting allowed. |
| `autopipe`, `vectorizer`, core `indexer`/`parse`/`hash`/`zip` | internal | Expanded from connector configs. |

### LLMs (all `questions → answers`, thin over `LLMBase`)
`llm_anthropic` (default profile `claude-sonnet-4-6`, 22 profiles, `extendedThinking`), `llm_openai` (50 profiles, Responses API reasoning stream), `llm_gemini` (1M context), `llm_bedrock` (AWS key pair), `llm_ollama` (local; only one with `temperature`/`reasoning_effort`), `llm_mistral`, `llm_deepseek`, `llm_qwen`, `llm_kimi`, `llm_minimax`, `llm_xai`, `llm_gmi_cloud`, `llm_baidu_qianfan`, `llm_openai_api` (any compatible endpoint), `llm_perplexity` (web-grounded). `llm_ibm_watson` ships no services.json (unusable).

### Vision LLMs (`image,documents → text,documents`; keep frame `time_stamp`)
`llm_vision_openai` (real system message, dedupe cache), `llm_vision_gemini` (dedupe cache), `llm_vision_mistral`, `llm_vision_ollama` (local). `accessibility_describe` (Gemini scene description → `text`).

### Agents (`questions → answers`, tools via `invoke`)
`agent_rocketride` (wave planner, requires a memory node), `agent_langchain`, `agent_llamaindex`, `agent_crewai` (+manager/subagent), `agent_deepagent` (+subagent). All also callable as tools (`<node>.run_agent`).

### Embeddings
| Node | Lanes | Notes |
| --- | --- | --- |
| `embedding_transformer` | `documents → documents`, `questions → questions` | local sentence-transformers (`miniLM` default, 384-dim), batches 64 docs, `document_prefix`/`query_prefix`. |
| `embedding_openai` | same | OpenAI key. |
| `embedding_image` | `documents(Image),image → documents` | CLIP/ViT. |
| `embedding_video` | `video → documents` | frame embeddings with `time_stamp` + `frame_number`. |

### Vector stores (`documents → –`, `questions → documents,answers,questions`)
`qdrant` (`local`/`cloud`; filter on `meta.objectId` MatchAny, `meta.parent` MatchText, chunk ranges; used by this app), `chroma` (HTTP client only), `store_postgres` (BYO pgvector, no index), `rocketride_vector` (cloud, HNSW), `milvus`, `weaviate`, `pinecone` (no namespaces), `astra`, `atlas`, `elasticsearch`/`opensearch` (BM25 + vector, exact-phrase search). All (except ES) expose `search`/`upsert`/`delete`/`get`/`stats` agent tools. Collections are per name; per-project scoping = `objectIds`/`parent` filters.

### Databases & graphs (`questions → table,text,answers`; NL→SQL/Cypher via invoke LLM)
`db_postgres` / `db_supabase`, `db_mysql`, `db_clickhouse`, `db_hotdata` (ephemeral per-run DB with bm25/vector indexes), `rocketride_sql` (cloud), `graph_neo4j`, `graph_falkordb`, `graph_arango`, `rocketride_graph` (cloud, AGE), `graph_hydradb` (tool only). `answers` lane inserts rows on the SQL nodes.

### Text processing
| Node | Lanes | Notes |
| --- | --- | --- |
| `preprocessor_langchain` | `text,table → documents` | chunker (recursive/character/markdown/nltk/spacy); chunks in `closing()`. |
| `preprocessor_llm` | `text,table → documents` | semantic chunks + summary chunk via invoke LLM. |
| `preprocessor_code` | `text → documents` | code splitter. |
| `summarization` | `text → text,documents` | summary / key points / entities (invoke LLM). |
| `extract_data`, `extract_facts` | `text,table,documents → answers,documents` | typed rows; facts carry `_provenance` + validation pass. |
| `ner` | `text,documents → text,documents` | entities into metadata. |
| `anonymize` | `text → text` | GLiNER PII masking (GPU). |
| `dictionary` | `text → documents` | glossary via invoke LLM. |
| `normalize_facts`, `schema_validate`, `currency_convert_explicit` | `answers → answers` | finance-specific, annotate-don't-drop pattern. |
| `guardrails` | `questions,answers,documents → same` | injection / PII / safety gate (warn or block). |
| `rerank_cohere` | `questions → documents,answers` | Cohere rerank of `question.documents`. |
| `search_exa` | `questions → answers,text` | direct web search. |
| `memory_persistent` | `questions,answers → same` | session context injection; `memory_internal` = agent scratchpad tool. |

### Audio & video
| Node | Lanes | Notes |
| --- | --- | --- |
| `audio_transcribe` | `audio,video → text` (+ `documents`) | faster-whisper; per-sentence `time_stamp` relative to the fed stream; no diarization. |
| `audio_tts` (Kokoro, local) / `tts_openai` / `tts_elevenlabs` | `text,documents,questions,answers → audio` | VO. |
| `audio_player` | `audio,video → –` | local device (`nosaas`). |
| `frame_grabber` | `video → image,documents,table` | frames (PNG) with `time_stamp`/`frame_number`; interval / scene-change / keyframe profiles; optional watermark. |
| `face_detection` | `image → text,image` | BlazeFace boxes + landmarks (no timestamp). Declares the `debug` capability: release builds of the engine skip it ("service not found"). |
| `detect`, `detect_segment`, `pose_estimation`, `depth_estimate`, `background_removal`, `image_cleanup`, `image_orient`, `scan_cropper`, `ocr`, `caption`, `thumbnail` | `image → …` | per-frame vision (mostly GPU-capable, local weights). |
| `video_composer` | `image → video` | frames → mp4 only (in-memory, ≤ ~500 frames). |
| `twelvelabs` | `video → text` | whole-video multimodal analysis (API key). |

### Tools (no lanes; bind to agents)
`tool_filesystem` (account file store: read/write/list/stat/delete + `filestore_source://` and `filestore://` sink with signed URLs), `tool_http_request`, `tool_python` (RestrictedPython, pure computation), `tool_daytona` (cloud sandbox with ffmpeg), `tool_n8n` (also a lane node), `tool_slack`, `tool_github`, `tool_git`, `tool_google_workspace` (5 services), `tool_microsoft_365` (5 services), `tool_pipedrive`, `tool_gohighlevel`, `tool_apify`, `tool_firecrawl`, `tool_tavily`, `tool_exa_search`, `tool_deepl`, `tool_chartjs`, `tool_v0`, `tool_bland_ai`, `tool_mcp_client` (+ Butterbase), `tool_guild`, memories: `tool_mem0`, `tool_xtrace_memory`, `tool_laserdata_memory`, `tool_cognee`, `tool_oura`.

## Where the app still needs custom nodes (and why)

| Custom node | Why no stock node covers it |
| --- | --- |
| `podcast_ingest` | Cuts the recording into ≤ 45 s 16 kHz pieces so the stock transcriber's buffer-relative timestamps map back to episode time; writes the project reference. |
| `podcast_segment` | Rebuilds absolute sentence times from `stream_index`, writes the transcript, builds the rubric questions and the timestamped index passages (metadata = episode id, so one store serves every episode). |
| `podcast_refine` | Sentence snapping, hard constraints (speaker / subject / exclusions / duration window / complete thoughts / overlaps), explainable ranking, compliance reports, request files. |
| `podcast_prepare_clip` | Word alignment, boundary snapping, filler/pause cut planning with safety rules, duration fitting, plan + compliance persistence. |
| `podcast_render` | ffmpeg mastering (−16 LUFS), cuts, mutes, 9:16 / 16:9 reframe, burned captions with presets, sidecars, reports. |
