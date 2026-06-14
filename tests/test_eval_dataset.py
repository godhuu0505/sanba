"""Guard the eval dataset's integrity and keep it pinned to the prompt version.

This is the cheap, always-on half of the LLMOps loop: it fails CI if the eval
set drifts out of sync with the prompt version, prompting whoever changed the
prompt to re-run the model-in-the-loop eval (scripts/run_eval.py)."""

import json
from pathlib import Path

from interviewer.prompts import PROMPT_VERSION

EVAL_PATH = Path(__file__).resolve().parents[1] / "evals" / "interviewer_eval.json"


def test_eval_dataset_is_valid_and_pinned():
    data = json.loads(EVAL_PATH.read_text())
    assert data["prompt_version"] == PROMPT_VERSION, (
        "Prompt changed without re-validating evals: bump evals/interviewer_eval.json "
        "prompt_version and re-run scripts/run_eval.py."
    )
    assert data["cases"], "eval set must not be empty"
    ids = [c["id"] for c in data["cases"]]
    assert len(ids) == len(set(ids))
    for case in data["cases"]:
        assert case["topic"]
        assert case["interviewee_opening"]
        assert case["must"], f"case {case['id']} has no assertions"
