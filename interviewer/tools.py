"""Agent tools (Tool Use).

These are plain Python functions; ADK derives each tool's schema from the type
hints and docstring, so the docstrings are written for the model to read.

The tools give the interviewer genuine agentic behaviour beyond chat:
  - ground_question  -> Agentic RAG over a domain-knowledge index (Elasticsearch)
  - search_past_sessions -> semantic recall of prior interviews (Elasticsearch)
  - save_session_log -> distil + persist the outcome, and index it for recall
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from interviewer.config import get_config
from interviewer.formatting import render_session_log_markdown, slugify
from interviewer.types import Decision, SessionLog


def ground_question(topic: str, focus: str) -> dict[str, Any]:
    """Retrieve relevant domain knowledge / best practices to ask a sharper question.

    Call this BEFORE asking, whenever the knowledge base might inform the
    question (e.g. common pitfalls, regulations, typical constraints in this
    domain). Returns short snippets you can weave into a more incisive question.

    Args:
        topic: the overall subject of the interview (e.g. "expense approval tool").
        focus: the specific thread you are probing right now (e.g. "approval routing").
    """
    cfg = get_config()
    if not cfg.elasticsearch_enabled:
        return {"status": "no_knowledge_base", "snippets": []}
    from interviewer.elastic import knn_search
    from interviewer.embeddings import embed_one

    vec = embed_one(f"{topic}\n{focus}")
    hits = knn_search(cfg.knowledge_index, query_embedding=vec, k=4)
    return {"status": "ok", "snippets": hits}


def search_past_sessions(query: str) -> dict[str, Any]:
    """Recall how similar past requirements were scoped.

    Use to avoid re-treading ground and to ask sharper follow-ups informed by
    prior interviews. Returns distilled summaries of the most similar sessions.

    Args:
        query: what you want to recall (e.g. "approval tools with SSO constraints").
    """
    cfg = get_config()
    if not cfg.elasticsearch_enabled:
        return {"status": "no_session_index", "sessions": []}
    from interviewer.elastic import knn_search
    from interviewer.embeddings import embed_one

    vec = embed_one(query)
    hits = knn_search(cfg.sessions_index, query_embedding=vec, k=3)
    return {"status": "ok", "sessions": hits}


def save_session_log(
    topic: str,
    intent: str,
    constraints: list[str],
    decisions: list[dict[str, str]],
    surfaced_assumptions: list[str],
    open_questions: list[str],
    out_of_scope: list[str],
) -> dict[str, Any]:
    """Distil and persist the interview outcome, closing the session.

    Call this once, at convergence, with the findings established in the
    conversation — do not invent. Each decision is {"decision","rationale"}.
    Persists Markdown (to Elasticsearch when configured, otherwise to ./.grill)
    and indexes the summary for future recall.

    Returns the saved location and the rendered Markdown.
    """
    log = SessionLog(
        topic=topic,
        intent=intent,
        constraints=constraints,
        decisions=[Decision(d.get("decision", ""), d.get("rationale", "")) for d in decisions],
        surfaced_assumptions=surfaced_assumptions,
        open_questions=open_questions,
        out_of_scope=out_of_scope,
    )
    markdown = render_session_log_markdown(log)
    cfg = get_config()

    # Always write a local copy (grill-me style) so a log is never lost.
    grill_dir = Path.cwd() / ".grill"
    grill_dir.mkdir(exist_ok=True)
    local_path = grill_dir / f"{slugify(topic)}.md"
    local_path.write_text(markdown, encoding="utf-8")
    location = str(local_path)

    if cfg.elasticsearch_enabled:
        from interviewer.elastic import index_document
        from interviewer.embeddings import embed_one

        summary = f"{topic}\n{intent}\n" + "\n".join(constraints)
        index_document(
            cfg.sessions_index,
            doc_id=os.getenv("SESSION_ID") or str(uuid.uuid4()),
            text=markdown,
            title=topic,
            embedding=embed_one(summary),
            metadata={"intent": intent},
        )
        location = f"elasticsearch://{cfg.sessions_index} (+ {local_path})"

    return {
        "status": "saved",
        "location": location,
        "markdown": markdown,
        "log": json.loads(json.dumps(log, default=lambda o: o.__dict__)),
    }
