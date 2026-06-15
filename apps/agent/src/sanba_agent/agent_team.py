"""ADK multi-agent team that analyses the conversation.

Topology (see docs/adr/0002):
    Interview Lead Agent (root)
      ├─ NFR sub-agent          (non-functional requirements)
      ├─ Scope sub-agent        (MoSCoW prioritisation)
      └─ Contradiction sub-agent (gap & contradiction detection)

The voice agent calls this team as an *agent-as-a-tool*, while the team itself
uses *sub-agents* internally. This deliberate mix is documented in ADR-0002.
"""

from __future__ import annotations

from functools import lru_cache

from google.adk.agents import Agent

from .config import settings
from .prompts.interview import (
    CONTRADICTION_AGENT_INSTRUCTIONS,
    LEAD_AGENT_INSTRUCTIONS,
    NFR_AGENT_INSTRUCTIONS,
    SCOPE_AGENT_INSTRUCTIONS,
)


@lru_cache(maxsize=1)
def build_interview_team() -> Agent:
    """Construct the requirements-analysis agent team (cached)."""
    model = settings.gemini_reasoning_model

    nfr_agent = Agent(
        name="nfr_specialist",
        model=model,
        description="非機能要件(性能/可用性/セキュリティ/コスト/運用性)の抜けを指摘する。",
        instruction=NFR_AGENT_INSTRUCTIONS,
    )
    scope_agent = Agent(
        name="scope_specialist",
        model=model,
        description="要件を MoSCoW で分類し、過大なスコープに MVP を提案する。",
        instruction=SCOPE_AGENT_INSTRUCTIONS,
    )
    contradiction_agent = Agent(
        name="contradiction_detector",
        model=model,
        description="過去の発話・確定要件との矛盾や抜けを検出する。",
        instruction=CONTRADICTION_AGENT_INSTRUCTIONS,
    )

    return Agent(
        name="interview_lead",
        model=model,
        description="要件インタビューを統括し、次に聞くべき1問を計画する。",
        instruction=LEAD_AGENT_INSTRUCTIONS,
        sub_agents=[nfr_agent, scope_agent, contradiction_agent],
    )
