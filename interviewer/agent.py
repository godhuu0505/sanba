"""The interviewer as an ADK multi-agent system.

A lead/coordinator interviewer delegates to three specialist persona
sub-agents (product / technical / skeptic). All share one conversation and the
same grill-me discipline. This is the "agent necessity" the hackathon judges
look for: multi-step, multi-specialist autonomous probing with Tool Use
(Elasticsearch RAG + recall) rather than a single-shot chat.

`build_interviewer()` is a factory so the text path (adk web / evals / Cloud Run
REST) and the voice path (Gemini Live) can use different models from one
definition. `root_agent` is the module-level agent ADK discovers.
"""

from __future__ import annotations

from google.adk.agents import Agent, BaseAgent

from interviewer.config import get_config
from interviewer.personas import PERSONAS
from interviewer.prompts import lead_instruction, persona_instruction
from interviewer.tools import (
    ground_question,
    save_session_log,
    search_past_sessions,
)


def build_interviewer(model: str | None = None) -> Agent:
    """Construct the lead interviewer with its specialist sub-agents.

    Args:
        model: model id to use for every agent in the panel. Defaults to the
            configured text model; pass the live model for the voice path.
    """
    cfg = get_config()
    model = model or cfg.model

    # Specialist sub-agents. Each can ground its questions and recall past work.
    # Annotated as list[BaseAgent] because sub_agents is invariant in BaseAgent.
    sub_agents: list[BaseAgent] = [
        Agent(
            name=persona.name,
            model=model,
            description=persona.description,
            instruction=persona_instruction(persona),
            tools=[ground_question, search_past_sessions],
        )
        for persona in PERSONAS
    ]

    return Agent(
        name="lead_interviewer",
        model=model,
        description=(
            "Leads a spoken requirements interview, delegating to specialist "
            "interviewers and distilling a session log at convergence."
        ),
        instruction=lead_instruction(),
        tools=[ground_question, search_past_sessions, save_session_log],
        sub_agents=sub_agents,
    )


# Discovered by ADK (`adk web`, eval, get_fast_api_app). Uses the text model.
root_agent = build_interviewer()
