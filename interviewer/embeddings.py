"""Embedding helper backed by Gemini / Vertex AI.

Used to power Elasticsearch vector search for the Agentic RAG and past-session
recall tools. Kept thin so it can be swapped for a different embedding model.
"""

from __future__ import annotations

from functools import lru_cache

from interviewer.config import get_config


@lru_cache(maxsize=1)
def _client():
    # Imported lazily so the package imports cleanly without google-genai
    # configured (e.g. in pure-logic unit tests).
    from google import genai

    return genai.Client()


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Return one embedding vector per input text."""
    if not texts:
        return []
    cfg = get_config()
    resp = _client().models.embed_content(model=cfg.embedding_model, contents=texts)
    return [list(e.values) for e in resp.embeddings]


def embed_one(text: str) -> list[float]:
    return embed_texts([text])[0]
