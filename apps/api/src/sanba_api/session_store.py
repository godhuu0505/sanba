"""Firestore-backed auth session store (ADR-0060).

不透明な SID を主キーに、検証済み Google identity をサーバ側で保持する。
Firestore が無い環境（単体テスト・オフライン開発）はインメモリ実装にフォールバックする。

境界:
  - identity（sub / email / email_verified / name）は ID トークン検証済みの値のみ書く。
  - Cookie 経路で参照するときは lookup + expires_at + revoked_at で失効判定する。
  - Firestore の TTL policy は infra 側で expires_at フィールドに設定する（本モジュールは
    書き込むだけ。物理削除は Firestore に任せる / インメモリ実装は都度掃除する）。
"""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from typing import Any, Protocol

import structlog

log = structlog.get_logger(__name__)

_SID_BYTES = 32
_COLLECTION = "auth_sessions"


@dataclass(frozen=True)
class AuthSession:
    """検証済み Google identity に紐づくサーバ側セッション。"""

    sid: str
    google_sub: str
    email: str
    email_verified: bool
    name: str
    created_at: int
    last_seen_at: int
    idle_expires_at: int
    expires_at: int
    revoked_at: int | None = None
    ua_hash: str = ""
    ip_hash: str = ""


def new_sid() -> str:
    """URL-safe な不透明 SID を生成する（256bit）。"""
    return secrets.token_urlsafe(_SID_BYTES)


def hash_metadata(value: str) -> str:
    """UA / IP を監査目的で短くハッシュする（生値を保存しない）。空文字はそのまま返す。"""
    if not value:
        return ""
    return hashlib.sha256(value.encode()).hexdigest()[:16]


class SessionStore(Protocol):
    """auth session の永続化境界。"""

    def create(self, session: AuthSession) -> None: ...

    def get(self, sid: str) -> AuthSession | None: ...

    def touch(self, sid: str, now: int, idle_expires_at: int) -> AuthSession | None: ...

    def revoke(self, sid: str, now: int) -> None: ...

    def revoke_by_sub(self, google_sub: str, now: int) -> int: ...


class InMemorySessionStore:
    """テスト・Firestore 不在時のフォールバック。"""

    def __init__(self) -> None:
        self._by_sid: dict[str, AuthSession] = {}

    def _purge_expired(self, now: int) -> None:
        expired = [sid for sid, s in self._by_sid.items() if s.expires_at <= now]
        for sid in expired:
            self._by_sid.pop(sid, None)

    def create(self, session: AuthSession) -> None:
        self._by_sid[session.sid] = session

    def get(self, sid: str) -> AuthSession | None:
        now = int(time.time())
        self._purge_expired(now)
        s = self._by_sid.get(sid)
        if s is None:
            return None
        if s.revoked_at is not None:
            return None
        if s.idle_expires_at <= now or s.expires_at <= now:
            return None
        return s

    def touch(self, sid: str, now: int, idle_expires_at: int) -> AuthSession | None:
        s = self._by_sid.get(sid)
        if s is None or s.revoked_at is not None:
            return None
        if s.expires_at <= now:
            return None
        updated = AuthSession(
            sid=s.sid,
            google_sub=s.google_sub,
            email=s.email,
            email_verified=s.email_verified,
            name=s.name,
            created_at=s.created_at,
            last_seen_at=now,
            idle_expires_at=idle_expires_at,
            expires_at=s.expires_at,
            revoked_at=s.revoked_at,
            ua_hash=s.ua_hash,
            ip_hash=s.ip_hash,
        )
        self._by_sid[sid] = updated
        return updated

    def revoke(self, sid: str, now: int) -> None:
        s = self._by_sid.get(sid)
        if s is None or s.revoked_at is not None:
            return
        self._by_sid[sid] = AuthSession(
            sid=s.sid,
            google_sub=s.google_sub,
            email=s.email,
            email_verified=s.email_verified,
            name=s.name,
            created_at=s.created_at,
            last_seen_at=s.last_seen_at,
            idle_expires_at=s.idle_expires_at,
            expires_at=s.expires_at,
            revoked_at=now,
            ua_hash=s.ua_hash,
            ip_hash=s.ip_hash,
        )

    def revoke_by_sub(self, google_sub: str, now: int) -> int:
        count = 0
        for sid, s in list(self._by_sid.items()):
            if s.google_sub == google_sub and s.revoked_at is None:
                self.revoke(sid, now)
                count += 1
        return count


def _to_doc(session: AuthSession) -> dict[str, Any]:
    return {
        "sid": session.sid,
        "google_sub": session.google_sub,
        "email": session.email,
        "email_verified": session.email_verified,
        "name": session.name,
        "created_at": session.created_at,
        "last_seen_at": session.last_seen_at,
        "idle_expires_at": session.idle_expires_at,
        "expires_at": session.expires_at,
        "revoked_at": session.revoked_at,
        "ua_hash": session.ua_hash,
        "ip_hash": session.ip_hash,
    }


def _from_doc(doc: dict[str, Any]) -> AuthSession | None:
    try:
        return AuthSession(
            sid=str(doc["sid"]),
            google_sub=str(doc["google_sub"]),
            email=str(doc.get("email", "")),
            email_verified=bool(doc.get("email_verified", False)),
            name=str(doc.get("name", "")),
            created_at=int(doc["created_at"]),
            last_seen_at=int(doc.get("last_seen_at", doc["created_at"])),
            idle_expires_at=int(doc["idle_expires_at"]),
            expires_at=int(doc["expires_at"]),
            revoked_at=int(doc["revoked_at"]) if doc.get("revoked_at") is not None else None,
            ua_hash=str(doc.get("ua_hash", "")),
            ip_hash=str(doc.get("ip_hash", "")),
        )
    except (KeyError, ValueError, TypeError) as exc:
        log.warning("auth_session_doc_corrupt", error=str(exc))
        return None


class FirestoreSessionStore:
    """Firestore バックエンド（本番経路）。"""

    def __init__(self, client: Any) -> None:
        self._col = client.collection(_COLLECTION)

    def create(self, session: AuthSession) -> None:
        self._col.document(session.sid).set(_to_doc(session))

    def get(self, sid: str) -> AuthSession | None:
        snap = self._col.document(sid).get()
        if not snap.exists:
            return None
        s = _from_doc(snap.to_dict() or {})
        if s is None:
            return None
        now = int(time.time())
        if s.revoked_at is not None:
            return None
        if s.idle_expires_at <= now or s.expires_at <= now:
            return None
        return s

    def touch(self, sid: str, now: int, idle_expires_at: int) -> AuthSession | None:
        ref = self._col.document(sid)
        snap = ref.get()
        if not snap.exists:
            return None
        s = _from_doc(snap.to_dict() or {})
        if s is None or s.revoked_at is not None:
            return None
        if s.expires_at <= now:
            return None
        ref.update({"last_seen_at": now, "idle_expires_at": idle_expires_at})
        return AuthSession(
            sid=s.sid,
            google_sub=s.google_sub,
            email=s.email,
            email_verified=s.email_verified,
            name=s.name,
            created_at=s.created_at,
            last_seen_at=now,
            idle_expires_at=idle_expires_at,
            expires_at=s.expires_at,
            revoked_at=s.revoked_at,
            ua_hash=s.ua_hash,
            ip_hash=s.ip_hash,
        )

    def revoke(self, sid: str, now: int) -> None:
        self._col.document(sid).update({"revoked_at": now})

    def revoke_by_sub(self, google_sub: str, now: int) -> int:
        query = self._col.where("google_sub", "==", google_sub).where("revoked_at", "==", None)
        count = 0
        for snap in query.stream():
            snap.reference.update({"revoked_at": now})
            count += 1
        return count


def build_default_store() -> SessionStore:
    """Firestore が使えれば FirestoreSessionStore、無ければ InMemorySessionStore。"""
    try:
        from google.cloud import firestore

        client = firestore.Client()
        return FirestoreSessionStore(client)
    except Exception as exc:  # pragma: no cover - depends on env
        log.warning("auth_session_store_using_memory", error=str(exc))
        return InMemorySessionStore()
