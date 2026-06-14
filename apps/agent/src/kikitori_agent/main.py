"""LiveKit Agents worker entrypoint.

The voice agent joins a LiveKit room and runs a speech-to-speech interview with
Gemini Live. During the conversation it calls the ADK agent team (as a tool) to
plan the next question and to persist confirmed requirements.

Run locally:
    python -m kikitori_agent.main dev
"""

from __future__ import annotations

import structlog
from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli
from livekit.agents.llm import function_tool
from livekit.plugins import google

from .config import settings
from .models import Priority, Requirement, RequirementCategory, Utterance
from .observability import setup_observability
from .prompts.interview import VOICE_AGENT_INSTRUCTIONS
from .repository import SessionRepository
from .tools.analysis import analyze_transcript, make_requirement_id

log = structlog.get_logger(__name__)


class KikitoriAgent(Agent):
    """The voice interviewer. Owns the tools that bridge to the ADK team."""

    def __init__(self, session_id: str, repo: SessionRepository) -> None:
        super().__init__(instructions=VOICE_AGENT_INSTRUCTIONS)
        self._session_id = session_id
        self._repo = repo
        self._transcript: list[str] = []

    def record_utterance(self, speaker: str, text: str) -> None:
        self._transcript.append(f"{speaker}: {text}")
        self._repo.add_utterance(self._session_id, Utterance(speaker=speaker, text=text))

    @function_tool
    async def analyze_requirements(self, _ctx: RunContext) -> dict:
        """これまでの会話から確定要件を点検し、次に聞くべき1問を返す。

        会話が一区切りついたとき、または論点が曖昧なときに呼び出す。
        """
        transcript = "\n".join(self._transcript)
        result = await analyze_transcript(transcript)
        log.info(
            "analysis",
            session=self._session_id,
            open_topics=result.open_topics,
            next_question=result.next_question,
        )
        return result.model_dump(mode="json")

    @function_tool
    async def save_requirement(
        self,
        _ctx: RunContext,
        statement: str,
        category: str = "functional",
        priority: str = "should",
        source_speaker: str | None = None,
    ) -> dict:
        """確定した要件を1件記録する。

        Args:
            statement: 要件の一文(例「同時に最大5人が音声で参加できること」)。
            category: functional / non_functional / constraint / scope / open_question
            priority: must / should / could / wont
            source_speaker: その要件を述べた参加者の識別子(任意)。
        """
        requirement = Requirement(
            id=make_requirement_id(statement),
            statement=statement,
            category=RequirementCategory(category),
            priority=Priority(priority),
            source_speaker=source_speaker,
        )
        self._repo.save_requirement(self._session_id, requirement)
        log.info("requirement_saved", session=self._session_id, id=requirement.id)
        return {"saved": requirement.id}


async def entrypoint(ctx: JobContext) -> None:
    """LiveKit job entrypoint: one invocation per room."""
    setup_observability()
    await ctx.connect()

    session_id = ctx.room.name
    repo = SessionRepository()
    agent = KikitoriAgent(session_id=session_id, repo=repo)

    session = AgentSession(
        llm=google.beta.realtime.RealtimeModel(
            model=settings.gemini_live_model,
            voice="Puck",
            temperature=0.7,
        ),
    )

    # Persist user turns so the ADK team always has the full transcript.
    @session.on("user_input_transcribed")
    def _on_user_text(ev) -> None:  # type: ignore[no-untyped-def]
        if getattr(ev, "is_final", False) and ev.transcript:
            speaker = "participant"
            agent.record_utterance(speaker, ev.transcript)

    await session.start(agent=agent, room=ctx.room)
    await session.generate_reply(
        instructions=(
            "まず自己紹介し、これから要件を一緒に整理することを伝え、"
            "最初の問いを1つだけ、推奨回答例を添えて投げかけてください。"
        )
    )


def main() -> None:
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()
