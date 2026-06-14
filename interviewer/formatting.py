"""Pure helpers for rendering the grill-style session log (no I/O, unit-tested)."""

from __future__ import annotations

import re

from interviewer.types import SessionLog


def slugify(topic: str) -> str:
    """A url/file-safe slug, mirroring grill-me's <slug>.md filenames."""
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:60]
    return slug or "session"


def render_session_log_markdown(log: SessionLog) -> str:
    """Render a SessionLog to grill-me-style Markdown, omitting empty sections."""
    parts: list[str] = [f"# {log.topic}", ""]

    if log.intent.strip():
        parts += ["## Intent", log.intent.strip(), ""]
    if log.constraints:
        parts += ["## Constraints", *[f"- {c}" for c in log.constraints], ""]
    if log.decisions:
        parts += [
            "## Key decisions",
            *[f"- **{d.decision}** — {d.rationale}" for d in log.decisions],
            "",
        ]
    if log.surfaced_assumptions:
        parts += [
            "## Surfaced assumptions",
            *[f"- {a}" for a in log.surfaced_assumptions],
            "",
        ]
    if log.open_questions:
        parts += ["## Open questions", *[f"- {q}" for q in log.open_questions], ""]
    if log.out_of_scope:
        parts += ["## Out of scope", *[f"- {o}" for o in log.out_of_scope], ""]

    return "\n".join(parts).rstrip() + "\n"
