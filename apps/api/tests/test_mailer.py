"""招待メール送信 (mailer / ADR-0036 決定3) のテスト。

実 SMTP には接続しない: smtplib.SMTP をフェイクに差し替え、
「未設定はスキップ」「設定済みは STARTTLS + 認証 + 送信」「失敗は False で握る
（招待の成立は止めない）」を検証する。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from sanba_api import mailer
from sanba_api.config import settings


def _send(**overrides: Any) -> bool:
    kwargs: dict[str, Any] = {
        "to": "invitee@example.com",
        "product_name": "請求アプリ",
        "inviter_email": "owner@example.com",
        "invite_url": "https://sanba.example.com/member-invites/tok",
        "expires_at": datetime(2026, 7, 20, tzinfo=UTC),
    }
    kwargs.update(overrides)
    return mailer.send_member_invite_email(**kwargs)


class _FakeSMTP:
    """smtplib.SMTP のフェイク（context manager + 呼び出し記録）。"""

    instances: list[_FakeSMTP] = []
    fail_on_send: bool = False

    def __init__(self, host: str, port: int, timeout: float) -> None:
        self.host, self.port, self.timeout = host, port, timeout
        self.calls: list[tuple[str, Any]] = []
        _FakeSMTP.instances.append(self)

    def __enter__(self) -> _FakeSMTP:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def starttls(self) -> None:
        self.calls.append(("starttls", None))

    def login(self, username: str, password: str) -> None:
        self.calls.append(("login", (username, password)))

    def send_message(self, msg: Any) -> None:
        if _FakeSMTP.fail_on_send:
            raise ConnectionError("boom")
        self.calls.append(("send", msg))


@pytest.fixture(autouse=True)
def _reset_fake() -> None:
    _FakeSMTP.instances.clear()
    _FakeSMTP.fail_on_send = False


def test_skips_when_smtp_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "smtp_host", "")
    assert _send() is False


def test_sends_with_starttls_and_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_username", "apikey")
    monkeypatch.setattr(settings, "smtp_password", "secret")
    monkeypatch.setattr(mailer.smtplib, "SMTP", _FakeSMTP)
    assert _send() is True
    (smtp,) = _FakeSMTP.instances
    assert smtp.host == "smtp.example.com"
    ops = [name for name, _ in smtp.calls]
    assert ops == ["starttls", "login", "send"]
    msg = smtp.calls[-1][1]
    assert msg["To"] == "invitee@example.com"
    assert "請求アプリ" in msg["Subject"]
    body = msg.get_content()
    assert "https://sanba.example.com/member-invites/tok" in body
    assert "owner@example.com" in body


def test_failure_returns_false_and_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(mailer.smtplib, "SMTP", _FakeSMTP)
    _FakeSMTP.fail_on_send = True
    assert _send() is False
