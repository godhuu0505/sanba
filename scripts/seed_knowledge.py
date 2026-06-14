"""Index domain-knowledge snippets into Elasticsearch for Agentic RAG grounding.

Usage:
    python scripts/seed_knowledge.py data/knowledge.sample.json

Each entry is {"id","title","text","metadata"?}. Requires ELASTICSEARCH_URL and
a Gemini/Vertex embedding configuration (see .env.example).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from interviewer.config import get_config
from interviewer.elastic import index_document
from interviewer.embeddings import embed_one


def main(path: str) -> None:
    cfg = get_config()
    if not cfg.elasticsearch_enabled:
        sys.exit("ELASTICSEARCH_URL is not set; nothing to seed.")

    entries = json.loads(Path(path).read_text())
    for entry in entries:
        index_document(
            cfg.knowledge_index,
            doc_id=entry["id"],
            title=entry.get("title"),
            text=entry["text"],
            embedding=embed_one(entry["text"]),
            metadata=entry.get("metadata", {}),
        )
        print(f"indexed {entry['id']}")
    print(f"done -> index '{cfg.knowledge_index}'")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/knowledge.sample.json")
