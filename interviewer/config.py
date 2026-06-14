"""Centralised, validated runtime configuration.

All environment access goes through here so misconfiguration fails fast with a
readable message instead of surfacing as a confusing runtime error deep in a
tool call.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Config:
    # --- Gemini / Vertex AI (the agents' model) -------------------------
    use_vertexai: bool
    google_cloud_project: str | None
    google_cloud_location: str
    # Reasoning model for the text/director path.
    model: str
    # Live (speech-to-speech) model for the voice path.
    live_model: str
    # Embedding model used for Elasticsearch vector search.
    embedding_model: str

    # --- Elasticsearch (Agentic RAG + session memory) -------------------
    elasticsearch_url: str | None
    elasticsearch_api_key: str | None
    knowledge_index: str
    sessions_index: str

    @property
    def elasticsearch_enabled(self) -> bool:
        return bool(self.elasticsearch_url)


@lru_cache(maxsize=1)
def get_config() -> Config:
    """Parse and cache configuration from the environment."""
    use_vertex = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "false").lower() in (
        "1",
        "true",
        "yes",
    )
    return Config(
        use_vertexai=use_vertex,
        google_cloud_project=os.getenv("GOOGLE_CLOUD_PROJECT") or None,
        google_cloud_location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
        model=os.getenv("MODEL", "gemini-2.5-flash"),
        live_model=os.getenv(
            "LIVE_MODEL", "gemini-2.0-flash-live-001"
        ),
        embedding_model=os.getenv("EMBEDDING_MODEL", "text-embedding-005"),
        elasticsearch_url=os.getenv("ELASTICSEARCH_URL") or None,
        elasticsearch_api_key=os.getenv("ELASTICSEARCH_API_KEY") or None,
        knowledge_index=os.getenv("ES_KNOWLEDGE_INDEX", "interview-knowledge"),
        sessions_index=os.getenv("ES_SESSIONS_INDEX", "interview-sessions"),
    )
