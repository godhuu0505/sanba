"""メンバー招待メールの送信。

SANBA 初のメール送信経路。SMTP（STARTTLS）を env/Secret Manager の設定で使い、
`smtp_host` 未設定ならスキップする（フェイルオープン: 招待はアプリ内通知でも届くため
メール不達で招待自体を失敗させない。skipped/failed はメトリクスとログで観測する /
CLAUDE.md 原則3）。呼び出しは FastAPI の BackgroundTasks から行い、応答をブロックしない。

依存を増やさないため標準ライブラリ（smtplib / email.message）のみを使う。
SendGrid 等のプロバイダも SMTP 互換エンドポイントがあるため、この設定面で足りる。
"""

from __future__ import annotations

import smtplib
from datetime import datetime
from email.message import EmailMessage

import structlog

from .config import settings
from .observability import record_member_invite_email

log = structlog.get_logger(__name__)

# 接続・送信のタイムアウト（秒）。背景タスクでも無限に掴まない。
_SMTP_TIMEOUT_SECONDS = 10.0


def _invite_body(
    *, product_name: str, inviter_email: str, invite_url: str, expires_at: datetime | None
) -> str:
    """招待メール本文（日本語プレーンテキスト）を組み立てる。"""
    lines = [
        f"{inviter_email} さんから、アプリ「{product_name}」の要件サンバに招待されました。",
        "",
        "以下の URL を開いて、招待を承諾または辞退してください。",
        invite_url,
        "",
        "SANBA にログインすると、アプリ内の通知からも応答できます。",
    ]
    if expires_at is not None:
        lines.append("")
        lines.append("この招待の有効期限: " + expires_at.astimezone().strftime("%Y-%m-%d %H:%M %Z"))
    lines += [
        "",
        "--",
        "SANBA — 音声で要件を引き出すマルチエージェント",
        "このメールに心当たりがない場合は破棄してください。",
    ]
    return "\n".join(lines)


def send_member_invite_email(
    *,
    to: str,
    product_name: str,
    inviter_email: str,
    invite_url: str,
    expires_at: datetime | None,
) -> bool:
    """メンバー招待メールを送る。送れたら True。

    SMTP 未設定（smtp_host 空）は skipped、送信例外は failed としてメトリクス・ログに
    残し False を返す（招待の成立自体は止めない）。宛先はログに残さない（PII 最小化。
    invite_id ベースの追跡は呼び出し側のログが担う）。
    """
    if not settings.smtp_host:
        record_member_invite_email("skipped")
        log.info("member_invite_email_skipped", reason="smtp_not_configured")
        return False

    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = f"【SANBA】「{product_name}」の要件サンバに招待されました"
    msg.set_content(
        _invite_body(
            product_name=product_name,
            inviter_email=inviter_email,
            invite_url=invite_url,
            expires_at=expires_at,
        )
    )
    try:
        with smtplib.SMTP(
            settings.smtp_host, settings.smtp_port, timeout=_SMTP_TIMEOUT_SECONDS
        ) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:  # pragma: no cover - 実 SMTP はテストでモックする
        record_member_invite_email("failed")
        log.warning("member_invite_email_failed", error=str(exc))
        return False
    record_member_invite_email("sent")
    log.info("member_invite_email_sent")
    return True
