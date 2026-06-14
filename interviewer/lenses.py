"""The interviewing lenses, adapted from grill-me's "question lenses".

Each lens is a distinct frame for probing intent and surfacing what the
interviewee has not yet said. The text is injected into the interviewer agents'
instructions so they know how to wield each frame.
"""

from __future__ import annotations

from dataclasses import dataclass

from interviewer.types import LensId


@dataclass(frozen=True)
class Lens:
    id: LensId
    name: str
    guidance: str


LENSES: tuple[Lens, ...] = (
    Lens(
        "first_principles",
        "First principles",
        "Strip the request to its irreducible goal. Ask what problem this "
        "actually solves and for whom, ignoring the proposed solution.",
    ),
    Lens(
        "constraints",
        "Constraint surfacing",
        "Draw out hard limits: budget, deadline, headcount, latency, "
        "compliance, existing systems. Make implicit constraints explicit.",
    ),
    Lens(
        "hidden_assumptions",
        "Hidden assumptions",
        "Name an assumption the interviewee seems to make without stating it, "
        "and ask whether it holds.",
    ),
    Lens(
        "pre_mortem",
        "Pre-mortem",
        "Imagine it is six months later and the project failed. Ask what most "
        "plausibly went wrong.",
    ),
    Lens(
        "steelman_opposition",
        "Steelman the opposition",
        "Make the strongest case for NOT doing this, or for the alternative, "
        "and ask the interviewee to respond.",
    ),
    Lens(
        "stakeholders",
        "Stakeholder perspectives",
        "Shift to a stakeholder who is not in the room (an end user, ops, "
        "legal, a sceptical exec) and ask how they would react.",
    ),
    Lens(
        "reversibility",
        "Reversibility test",
        "Ask whether a decision is a one-way or two-way door, and whether it is "
        "being treated with the right level of caution.",
    ),
    Lens(
        "five_whys",
        "Five whys",
        "Recursively ask 'why' on the last answer to reach the root motivation "
        "rather than the surface request.",
    ),
    Lens(
        "boundaries",
        "Boundary definition",
        "Pin down what is explicitly in scope versus out of scope, and where "
        "the edges of the system are.",
    ),
    Lens(
        "sustainability",
        "Sustainability check",
        "Probe what happens after launch: ownership, maintenance, on-call, cost "
        "over time, and who keeps it alive.",
    ),
)

_LENS_IDS = frozenset(lens.id for lens in LENSES)


def is_lens_id(value: object) -> bool:
    """True if value is a known lens id."""
    return isinstance(value, str) and value in _LENS_IDS


def render_lens_catalogue() -> str:
    """Render the lenses as a bullet list for an agent instruction."""
    return "\n".join(
        f"- {lens.id} ({lens.name}): {lens.guidance}" for lens in LENSES
    )
