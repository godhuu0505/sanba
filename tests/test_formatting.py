from interviewer.formatting import render_session_log_markdown, slugify
from interviewer.types import Decision, SessionLog


def test_slugify():
    assert slugify("Expense Approval Tool!") == "expense-approval-tool"
    assert slugify("   ") == "session"


def test_render_full_log():
    log = SessionLog(
        topic="Expense tool",
        intent="Cut approval latency",
        constraints=["SSO required"],
        decisions=[Decision("Reuse IdP", "cost")],
        surfaced_assumptions=["email exists"],
        open_questions=["contractors?"],
        out_of_scope=["mobile"],
    )
    md = render_session_log_markdown(log)
    assert "# Expense tool" in md
    assert "## Intent" in md
    assert "**Reuse IdP** — cost" in md
    assert "## Out of scope" in md


def test_render_omits_empty_sections():
    log = SessionLog(topic="T", intent="do a thing")
    md = render_session_log_markdown(log)
    assert "## Intent" in md
    assert "## Constraints" not in md
    assert "## Key decisions" not in md
