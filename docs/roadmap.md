# Roadmap

Finish the multi-agent 1:1 voice interview, then grow to many humans — without
reshaping the participant-aware data model.

## Phase 1 — multi-agent voice interview (this scaffold)

- [x] ADK multi-agent panel: lead + product/technical/skeptic sub-agents
      (`interviewer/agent.py`), grill-me discipline + lenses.
- [x] Tool Use: `ground_question` (Elasticsearch RAG), `search_past_sessions`
      (recall), `save_session_log` (distil + persist + index).
- [x] Gemini Live voice path (`/ws/voice`, `run_live`).
- [x] Cloud Run deploy (Dockerfile, Terraform, Cloud Build).
- [x] DevOps: CI (ruff/mypy/pytest), IaC, Cloud Logging/Trace, LLMOps eval set.
- [ ] Live + sub-agent delegation polish (ADK live transfer is evolving; today
      the lead drives the live session, full panel runs on the text path).
- [ ] Browser voice client UI (mic capture → PCM16 → `/ws/voice`).
- [ ] Seed a real domain-knowledge corpus into Elasticsearch.

## Phase 2 — many humans, one panel

- [ ] **Room + diarisation.** Collect per-participant audio (or diarise a mixed
      stream) and tag each completed transcript with the speaker before it
      reaches the agents.
- [ ] **Floor control.** A coordinator decides who is addressed next
      (round-robin / follow-the-thread / who-hasn't-spoken) and prevents two
      questions at once across humans and agents.
- [ ] Cloud Run already autoscales; the room service is the new long-lived
      component to add.

## Phase 3 — full panel × full room

- [ ] Multiple humans + the specialist panel together, with barge-in and
      hand-raise semantics.
- [ ] Per-agent lens budgets so the panel covers breadth without thrashing.

## Cross-cutting backlog

- [ ] Persistent session memory across interviews via Elasticsearch + the
      `search_past_sessions` recall loop (foundation already in place).
- [ ] Auth + per-tenant isolation.
- [ ] Export logs to the team's tools (Slack / Google Doc / Asana) — MCP
      integrations available in this workspace.
- [ ] Expand the eval set; wire `scripts/run_eval.py` into a nightly Cloud Build
      job and track the score over time (LLMOps).
- [ ] Cost guardrails: budget alerts + per-session token dashboards.
