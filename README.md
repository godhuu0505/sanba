# Voice Requirements Interviewer

A [grill-me](https://github.com/mattpocock/skills/tree/main/skills/grill-me)-inspired
**multi-agent voice interviewer** that talks with you to surface what you
actually want — intent, constraints, hidden assumptions, unstated alternatives —
before any implementation begins.

Built for **DevOps × AI Agent Hackathon 2026** (Findy × Google Cloud). It leans
into the hackathon's three verbs — **つくる・まわす・とどける** — with a
production-shaped DevOps cycle, not just a working demo.

## Why an agent (necessity)

This is not a chatbot. A **panel of specialist ADK sub-agents** (product /
technical / skeptic) runs one coherent spoken interview: the **lead interviewer**
delegates a thread to whichever specialist probes it best, each specialist drills
with Tool Use — **grounding questions via Elasticsearch RAG** and **recalling
past sessions** — and the lead distils a session log at convergence. Multi-step,
multi-specialist, autonomous probing with real tools and memory.

## Stack ↔ hackathon requirements

| Requirement | This project |
|---|---|
| **必須** Google Cloud 実行プロダクト | **Cloud Run** (Terraform + Cloud Build) |
| **必須** Google Cloud AI 技術 | **Gemini via Vertex AI + ADK** multi-agent; **Gemini Live** voice; **Speech transcription** |
| **任意** スポンサー技術 | **Elasticsearch** vector search — Agentic RAG grounding + past-session recall |
| **まわす** (DevOps) | CI (ruff/mypy/pytest), Cloud Build CD, IaC, Cloud Logging/Trace, **LLMOps** (versioned prompts + eval set + regression guard) |

Design detail: [`docs/architecture.md`](docs/architecture.md) ·
Roadmap (1:1 → many-to-many): [`docs/roadmap.md`](docs/roadmap.md) ·
Ops & DevOps cycle: [`docs/devops.md`](docs/devops.md) ·
Hackathon strategy: [`docs/hackathon/`](docs/hackathon/)

## Architecture (short)

```
Voice (Gemini Live, WebSocket)            Text/eval (ADK REST, adk web)
                \                          /
                 ▼                        ▼
            ┌──────────────────────────────────┐
            │  lead_interviewer (ADK, Gemini)   │  grill-me discipline
            │   ├─ product_interviewer (sub)    │  one Q at a time, drill,
            │   ├─ technical_interviewer (sub)  │  lens selection, converge
            │   └─ skeptic_interviewer  (sub)   │
            │  tools: ground_question,          │
            │         search_past_sessions,     │──► Elasticsearch (kNN vector)
            │         save_session_log          │
            └──────────────────────────────────┘
                         Cloud Run
```

## Quick start (local)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env          # set Vertex AI (or GOOGLE_API_KEY); Elasticsearch optional

# Inspect / drive the multi-agent panel in the dev UI:
adk web            # then open the printed URL, pick "interviewer"
# or run the full server (REST + voice WebSocket + /healthz):
uvicorn main:app --reload

pytest             # pure-logic tests; no Gemini/Elasticsearch needed
ruff check . && mypy interviewer
```

Without Elasticsearch the RAG/recall tools degrade gracefully and session logs
fall back to `./.grill/<slug>.md` (mirroring grill-me's on-disk log).

## Deploy (Cloud Run)

```bash
gcloud run deploy voice-requirements-interviewer \
  --source . --region us-central1 \
  --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=us-central1
```

Or Terraform (`infra/terraform`) + Cloud Build (`cloudbuild.yaml`) for CD.

## Layout

```
interviewer/        ADK agent package (root_agent = lead + persona sub-agents)
  agent.py          multi-agent wiring (build_interviewer factory)
  personas.py       product / technical / skeptic specialists
  prompts.py        grill-me discipline + versioned prompts (LLMOps)
  lenses.py         the grill-me question lenses
  tools.py          ground_question / search_past_sessions / save_session_log
  elastic.py        Elasticsearch kNN wrapper
  embeddings.py     Gemini/Vertex embeddings
  formatting.py     session-log Markdown (pure, tested)
main.py             Cloud Run app: ADK REST + Gemini Live WebSocket + /healthz
evals/              LLMOps eval dataset (pinned to prompt version)
scripts/            seed_knowledge.py, run_eval.py
infra/              Terraform (Cloud Run + Artifact Registry) + Elastic notes
docs/               architecture, roadmap, devops, hackathon strategy
```
