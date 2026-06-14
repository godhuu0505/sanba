# DevOps — つくる・まわす・とどける

The hackathon's differentiator is the **full DevOps cycle**, not a working demo.
This is how each verb is implemented and what to say in the pitch.

## まわす — CI / quality

`.github/workflows/ci.yml` on every push/PR:

1. `ruff check` — lint
2. `mypy interviewer` — typecheck
3. `pytest` — pure-logic unit tests (lenses, prompts, session-log rendering,
   tool graceful-degradation, eval-set integrity). **No Gemini/Elasticsearch or
   network needed**, so CI is fast and deterministic.
4. `docker build` — the Cloud Run image builds.

## まわす — LLMOps (the agent improvement loop)

This is what separates an "agent that works" from one that's **operable**:

- **Versioned prompts.** `interviewer/prompts.py` carries `PROMPT_VERSION`. The
  interview discipline lives in code, reviewed via PRs.
- **Eval dataset.** `evals/interviewer_eval.json` scripts interviewee scenarios
  with the qualities the interviewer must exhibit (asks one question, drills
  vague answers, doesn't jump to a solution…), pinned to `PROMPT_VERSION`.
- **Always-on guard.** `tests/test_eval_dataset.py` fails CI if the prompt
  changes without re-validating the eval set — cheap, no network.
- **Model-in-the-loop eval.** `scripts/run_eval.py` runs each scenario through
  the agent and uses an LLM judge to score it. Run locally / nightly (needs
  Gemini); track the pass rate across prompt versions to catch regressions.

## とどける — CD / deploy

- **Cloud Run** is the required execution product. `Dockerfile` builds a slim
  image running `uvicorn main:app`; `main.py` serves ADK REST + the Gemini Live
  WebSocket + `/healthz`.
- **Cloud Build** (`cloudbuild.yaml`) builds → pushes to Artifact Registry →
  `gcloud run deploy`. Wire a GitHub trigger so main ships automatically.
- **IaC** (`infra/terraform`) provisions APIs, Artifact Registry, a
  least-privilege runtime service account (Vertex AI + Cloud Trace only), and
  the Cloud Run service with autoscaling 0→4.

## Observability

- **Logs** — Cloud Run ships container stdout to **Cloud Logging** with no
  setup; ADK logs agent/tool events there.
- **Traces** — `opentelemetry-exporter-gcp-trace` is included; the runtime SA
  has `roles/cloudtrace.agent`. Set the OTel endpoint to export spans (model
  calls, tool calls) to **Cloud Trace**.
- **Health** — `GET /healthz` reports model + integration wiring (no secrets).
- **Cost** — set a GCP **budget alert**; Vertex AI usage and Cloud Run request
  metrics are visible in Cloud Monitoring.

## Configuration & secrets

- All env access goes through `interviewer/config.py` with sensible defaults, so
  the app runs locally with minimal setup and fails clearly when a required
  value (e.g. Vertex project) is missing in production.
- Secrets (Elasticsearch key, etc.) come from Cloud Run env / Secret Manager;
  nothing secret is committed. Vertex AI auth uses the runtime service account
  (no API key in the container).

## Local dev

```bash
pip install -r requirements-dev.txt
adk web                      # drive the multi-agent panel in the dev UI
uvicorn main:app --reload    # full server (REST + /ws/voice + /healthz)
python scripts/seed_knowledge.py data/knowledge.sample.json   # seed RAG (needs ES)
pytest && ruff check . && mypy interviewer
```

## Pitch checklist mapping (`docs/hackathon`)

- 課題/ペルソナ — requirements-gathering for builders; the interview *is* the
  before/after.
- エージェントの必然性 — multi-agent panel + Tool Use (RAG/recall), not a chat.
- アーキテクチャ図 + DevOps図 — `docs/architecture.md` (GCP services) + this file.
- 本番品質 — Cloud Run autoscale, IaC, observability, LLMOps regression loop.
