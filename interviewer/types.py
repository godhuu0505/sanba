"""Shared domain types.

Participant-aware from the start so the 1:1 -> many-to-many evolution (see
docs/roadmap.md) does not require reshaping data. In the ADK multi-agent design
each interviewer persona is an `agent` participant.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Role = Literal["human", "agent"]

# The grill-me-derived interviewing lenses.
LensId = Literal[
    "first_principles",
    "constraints",
    "hidden_assumptions",
    "pre_mortem",
    "steelman_opposition",
    "stakeholders",
    "reversibility",
    "five_whys",
    "boundaries",
    "sustainability",
]


@dataclass
class Participant:
    id: str
    role: Role
    name: str
    persona: str | None = None


@dataclass
class Turn:
    speaker_id: str
    speaker_role: Role
    text: str
    at: int  # epoch ms


@dataclass
class Decision:
    decision: str
    rationale: str


@dataclass
class SessionLog:
    topic: str
    intent: str
    constraints: list[str] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    surfaced_assumptions: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    out_of_scope: list[str] = field(default_factory=list)
