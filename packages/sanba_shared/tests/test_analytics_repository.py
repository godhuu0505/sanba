from sanba_shared.repository import SessionRepository


def _repo() -> SessionRepository:
    repo = SessionRepository()
    repo._client = None
    return repo


def test_add_and_get_session_ai_cost_accumulates() -> None:
    repo = _repo()
    repo.add_session_ai_cost(
        "sess-1", component="live_audio", usd=1.5, input_tokens=100, output_tokens=50
    )
    repo.add_session_ai_cost(
        "sess-1", component="live_audio", usd=0.5, input_tokens=10, output_tokens=5
    )
    repo.add_session_ai_cost("sess-1", component="title", usd=0.01, input_tokens=200)
    cost = repo.get_session_ai_cost("sess-1")
    assert cost["total_usd"] == 2.01
    assert cost["components"]["live_audio"]["usd"] == 2.0
    assert cost["components"]["live_audio"]["input_tokens"] == 110
    assert cost["components"]["live_audio"]["requests"] == 2
    assert cost["components"]["title"]["input_tokens"] == 200


def test_get_session_ai_cost_missing_is_empty() -> None:
    repo = _repo()
    assert repo.get_session_ai_cost("nope") == {"total_usd": 0.0, "components": {}}


def test_set_and_get_session_cost_summary() -> None:
    repo = _repo()
    assert repo.get_session_cost_summary("sess-1") is None
    repo.set_session_cost_summary("sess-1", {"total_usd": 1.0, "total_jpy": 150.0})
    summary = repo.get_session_cost_summary("sess-1")
    assert summary == {"total_usd": 1.0, "total_jpy": 150.0}


def test_save_transcript_masks_pii_and_counts_lines() -> None:
    repo = _repo()
    repo.save_transcript(
        "sess-1",
        "[u1] participant: 連絡先は taro@example.com です\n[u2] SANBA: 承知しました\n",
        apply_ttl=False,
    )
    stored = repo.get_transcript("sess-1")
    assert stored is not None
    assert "[EMAIL]" in stored["text"]
    assert "taro@example.com" not in stored["text"]
    assert stored["line_count"] == 2


def test_save_transcript_without_masking() -> None:
    repo = SessionRepository(mask_pii_before_persist=False)
    repo._client = None
    repo.save_transcript("sess-1", "call taro@example.com", apply_ttl=True)
    stored = repo.get_transcript("sess-1")
    assert stored is not None
    assert "taro@example.com" in stored["text"]
