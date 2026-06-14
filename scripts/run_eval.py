"""Model-in-the-loop interview-quality eval (the LLMOps regression loop).

For each scripted scenario in evals/interviewer_eval.json, runs the interviewee
opening through the interviewer and uses an LLM judge to score the response
against the case's `must` qualities. Prints a pass/fail summary and a score.

Run manually / in a nightly job (needs Gemini access — not in CI):
    python scripts/run_eval.py

Pair with the cheap, always-on guard in tests/test_eval_dataset.py.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from google.adk.runners import InMemoryRunner
from google.genai import types

from interviewer.agent import build_interviewer
from interviewer.config import get_config

EVAL_PATH = Path(__file__).resolve().parents[1] / "evals" / "interviewer_eval.json"


async def _first_reply(opening: str) -> str:
    runner = InMemoryRunner(agent=build_interviewer(), app_name="eval")
    session = await runner.session_service.create_session(
        app_name="eval", user_id="eval"
    )
    text_parts: list[str] = []
    async for event in runner.run_async(
        user_id="eval",
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=opening)]
        ),
    ):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    text_parts.append(part.text)
    return "\n".join(text_parts)


def _judge(reply: str, must: list[str]) -> dict:
    from google import genai

    cfg = get_config()
    schema = {
        "type": "object",
        "properties": {
            "passed": {"type": "boolean"},
            "failures": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["passed", "failures"],
    }
    prompt = (
        "You are grading an interviewer's reply. Reply:\n"
        f"---\n{reply}\n---\n"
        "It must satisfy ALL of these qualities:\n"
        + "\n".join(f"- {m}" for m in must)
        + "\nReturn JSON {passed, failures[]} listing any unmet qualities."
    )
    resp = genai.Client().models.generate_content(
        model=cfg.model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json", response_schema=schema
        ),
    )
    return json.loads(resp.text)


async def main() -> None:
    data = json.loads(EVAL_PATH.read_text())
    passed = 0
    for case in data["cases"]:
        reply = await _first_reply(case["interviewee_opening"])
        verdict = _judge(reply, case["must"])
        ok = verdict["passed"]
        passed += int(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {case['id']}")
        for failure in verdict.get("failures", []):
            print(f"        - {failure}")
    total = len(data["cases"])
    print(f"\n{passed}/{total} cases passed (prompt {data['prompt_version']})")


if __name__ == "__main__":
    asyncio.run(main())
