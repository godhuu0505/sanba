from interviewer.lenses import LENSES
from interviewer.personas import PERSONAS
from interviewer.prompts import PROMPT_VERSION, lead_instruction, persona_instruction


def test_prompt_version_is_set():
    assert PROMPT_VERSION


def test_lead_instruction_carries_grill_discipline_and_lenses():
    text = lead_instruction()
    # grill-me core discipline must be present.
    assert "ONE question at a time" in text
    assert "DRILL" in text
    # Every lens id must be available to the agent.
    for lens in LENSES:
        assert lens.id in text
    # The lead must know its panel and the closing tool.
    for persona in PERSONAS:
        assert persona.name in text
    assert "save_session_log" in text


def test_persona_instruction_mentions_persona_and_handback():
    for persona in PERSONAS:
        text = persona_instruction(persona)
        assert persona.name in text
        assert "hand control back" in text
