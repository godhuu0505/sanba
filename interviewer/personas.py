"""Interviewer personas for the multi-agent panel.

Each persona becomes an ADK sub-agent of the lead interviewer. A panel of
specialists is the "agent necessity" the judges look for: the lead delegates to
whichever specialist best probes the current thread, and they share one
transcript so they build on each other rather than repeat.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Persona:
    # ADK agent name (must be a valid identifier: lowercase + underscores).
    name: str
    # One-line description used by the lead agent to decide when to delegate.
    description: str
    # The lens bias and stance this persona brings.
    focus: str


PERSONAS: tuple[Persona, ...] = (
    Persona(
        name="product_interviewer",
        description=(
            "Probes user value, the underlying problem, target users, and "
            "success metrics. Use when intent or 'who is this for' is unclear."
        ),
        focus=(
            "Lean on first_principles, stakeholders, and five_whys. Relentlessly "
            "pin down the real problem and who actually has it."
        ),
    ),
    Persona(
        name="technical_interviewer",
        description=(
            "Probes feasibility, constraints, integrations, data, scale, and "
            "non-functional requirements. Use when the discussion turns to how."
        ),
        focus=(
            "Lean on constraints, boundaries, and sustainability. Surface "
            "latency, data, scale, security, and who maintains it after launch."
        ),
    ),
    Persona(
        name="skeptic_interviewer",
        description=(
            "Stress-tests the idea: risks, failure modes, and the strongest "
            "case against. Use when an answer sounds too easy or unexamined."
        ),
        focus=(
            "Lean on pre_mortem, steelman_opposition, and reversibility. Make "
            "the strongest case for NOT doing this and force a real response."
        ),
    ),
)
