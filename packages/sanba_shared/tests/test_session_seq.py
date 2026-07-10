from __future__ import annotations

from sanba_shared.repository import SessionRepository


def test_set_session_seq_never_regresses() -> None:
    repo = SessionRepository()
    repo.set_session_seq("s1", 5)
    assert repo.get_session_seq("s1") == 5

    repo.set_session_seq("s1", 3)
    assert repo.get_session_seq("s1") == 5

    repo.set_session_seq("s1", 8)
    assert repo.get_session_seq("s1") == 8


def test_set_session_seq_is_isolated_per_session() -> None:
    repo = SessionRepository()
    repo.set_session_seq("a", 7)
    repo.set_session_seq("b", 2)
    assert repo.get_session_seq("a") == 7
    assert repo.get_session_seq("b") == 2
