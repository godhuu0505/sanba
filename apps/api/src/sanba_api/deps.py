"""横断依存: シングルトン（repo / indexer / asset store）と認可・共有ヘルパ。

routers/* はここから import する（routers → deps → リーフモジュールの一方向。
deps は main / routers を import しない）。main.py は tests の後方互換のため、
ここで生成するシングルトン（`_repo` 等）を同一オブジェクトのまま再エクスポートする。
"""

from __future__ import annotations

import json
import os
import re
import time
from collections import defaultdict, deque
from datetime import timedelta
from typing import Any

import structlog
from fastapi import Header, HTTPException
from livekit import api
from pydantic import BaseModel
from sanba_shared.models import Product, SessionMeta
from sanba_shared.repository import SessionRepository

from .auth import (
    InvalidSessionToken,
    SessionAccess,
    create_session_token,
    verify_session_token,
)
from .auth_google import AuthUser, is_admin
from .config import settings
from .github_app import GitHubAppClient
from .ingestion import ContextIndexer
from .repository import ReadRepository
from .storage import AssetStore

log = structlog.get_logger(__name__)


def _get_tracer() -> Any:
    """OTel トレーサ（未設定なら None で no-op）。アップロード〜解析を span 化する。"""
    try:
        from opentelemetry import trace

        return trace.get_tracer("sanba_api.assets")
    except Exception:  # pragma: no cover - otel optional
        return None


_join_hits: dict[str, deque[float]] = defaultdict(deque)


def _over_rate_limit(client_ip: str) -> bool:
    """sliding-window で join が上限超過なら True（上限内なら副作用でヒットを記録）。

    判定を関数に切り出し、body 解析より前のミドルウェア層から呼ぶ。
    """
    window_start = time.time() - 60
    hits = _join_hits[client_ip]
    while hits and hits[0] < window_start:
        hits.popleft()
    if len(hits) >= settings.join_rate_per_minute:
        return True
    hits.append(time.time())
    return False


_indexer = ContextIndexer()

_asset_store = AssetStore()

if settings.firestore_emulator_host:
    os.environ.setdefault("FIRESTORE_EMULATOR_HOST", settings.firestore_emulator_host)

_repo = SessionRepository(
    data_retention_days=settings.data_retention_days,
    mask_pii_before_persist=settings.mask_pii_before_index,
)

_read_repo = ReadRepository()


def require_session_access(
    session_id: str, authorization: str | None = Header(default=None)
) -> SessionAccess:
    """Hydration/export を「join 済みトークン」で保護する（契約 §4）。

    `session_id` をパスに含むだけでは参加者以外に漏洩するため、join 時に発行した
    署名付きセッショントークン（Bearer）を検証し、パスの session_id と一致させる。
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing session token")
    token = authorization[len("Bearer ") :]
    try:
        access = verify_session_token(token, settings.session_signing_secret)
    except InvalidSessionToken as exc:
        log.warning("session_token_rejected", reason=str(exc))
        raise HTTPException(status_code=403, detail=f"invalid session token: {exc}") from exc
    if access.session_id != session_id:
        raise HTTPException(status_code=403, detail="session mismatch")
    return access


_GUEST_SUB_PREFIX = "guest:"


def forbid_guest_writes(access: SessionAccess, operation: str) -> None:
    """ゲスト session_token の権限最小性を強制する。

    ゲスト token に許すのは当該セッションの読取（ハイドレーション）と telemetry・
    realtime の client event のみ。素材投入（grounding 汚染）・確定・起票（owner の
    repo への Issue 作成）・素材削除は 403 で拒む。ゲストセッションの要件の承認・
    保全は owner が管理画面で行う（承認時に TTL 解除するかは owner の意思）。
    """
    if access.sub.startswith(_GUEST_SUB_PREFIX):
        log.warning(
            "guest_write_denied",
            session=access.session_id,
            operation=operation,
            sub=access.sub,
        )
        raise HTTPException(status_code=403, detail="guests cannot perform this operation")


_GITHUB_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _github_repo_allowed(repo: str) -> bool:
    """許可リスト（GITHUB_REPO_ALLOWLIST）に照らして選択可否を返す。

    エントリは "owner"（配下すべて）または "owner/name"。リスト空 = 制限なし。
    候補一覧（GET /api/github/repos）と保存（POST /api/sessions）の両方が同じ判定を使い、
    一覧に出ないリポジトリを直接 POST で保存する抜け道を塞ぐ。
    """
    entries = [e.strip() for e in settings.github_repo_allowlist.split(",") if e.strip()]
    if not entries:
        return True
    owner = repo.split("/", 1)[0]
    return any(e == repo or e == owner for e in entries)


def _confirmed_requirements(session_id: str) -> list[dict[str, Any]]:
    """会話確定軸（contract: confirmed）の要件のみを返す（確定判定の単一の定義）。

    `requirement_doc_to_contract` が管理軸 rejected を draft に落とすため、却下要件はここで
    除外される。確定判定はこの 1 箇所に集約し finalize のスナップショット算出だけが使う。
    export は finalize 済みスナップショット（`finalized_requirement_ids`）を起票するため
    この関数を呼ばない＝確定判定が finalize と export で重複しない（重複定義禁止）。
    """
    return [r for r in _read_repo.list_requirements(session_id) if r["status"] == "confirmed"]


def _finalized_snapshot_requirements(session: SessionMeta) -> list[dict[str, Any]]:
    """finalize 時に凍結した要件集合を契約形で返す（凍結保証の単一定義）。

    export と過去要件閲覧（GET /api/sessions/mine/{id}/requirements）が共有する。確定後に
    遅延 agent が要件を追加したり管理画面 API で却下されても、確定時集合を再計算せず固定する
    未 finalize ならスナップショットは空。

    後方互換: 本機能デプロイ前に finalized になった旧文書は ID スナップショットを
    持たない（既定 []）。`status==finalized` かつ確定件数 > 0 で ID 集合だけ欠落しているケースは
    旧挙動（確定要件の再計算）にフォールバックし、確定済みセッションを空にしない。
    """
    snapshot_ids = session.finalized_requirement_ids
    legacy_finalized_without_snapshot = (
        not snapshot_ids and session.status == "finalized" and (session.finalized_count or 0) > 0
    )
    if legacy_finalized_without_snapshot:
        return _confirmed_requirements(session.id)
    return _read_repo.get_requirements_by_ids(session.id, snapshot_ids)


def _github_app_client() -> GitHubAppClient | None:
    """設定済みなら App クライアントを返す。未設定はフェイルクローズ（None）。"""
    if not (
        settings.github_app_enabled and settings.github_app_id and settings.github_app_private_key
    ):
        return None
    return GitHubAppClient(
        settings.github_app_id,
        settings.github_app_private_key,
        oauth_client_id=settings.github_app_client_id,
        oauth_client_secret=settings.github_app_client_secret,
    )


def _require_product_access(product_id: str, user: AuthUser, *, manage: bool = False) -> Product:
    """product 認可の一点集約（要件 NFR-6）。

    manage=False（既定）: owner / admin / メンバー。閲覧と要件サンバの実施
    （product 従属セッションの作成）に足りる権限。
    manage=True: owner / admin のみ。設定変更・リンク/招待の発行・削除などの管理操作。
    非関係者・不存在はどちらも 404 に平す（`/api/sessions/mine/{id}` と同じ:
    応答差で他人の product ID の存在を漏らさない）。メンバーの manage 要求は 403
    （メンバーには存在が見えているため秘匿の意味がなく、理由を返す方が UI で扱える）。
    org / テナントを将来導入するときは、この関数の判定を sub → org → product に
    差し替える（他の場所に判定を増やさない）。web 側の判定は表示制御のみで、
    認可の源泉は常にここ。
    """
    product = _repo.get_product(product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="product not found")
    if product.owner_sub == user.sub or is_admin(user):
        return product
    if _repo.get_product_member(product_id, user.sub) is None:
        raise HTTPException(status_code=404, detail="product not found")
    if manage:
        raise HTTPException(status_code=403, detail="owner or admin only")
    return product


class JoinResponse(BaseModel):
    token: str
    livekit_url: str
    session_id: str
    identity: str
    session_token: str


def _mint_join_tokens(
    session_id: str, role: str, identity: str, display_name: str, sub: str, email: str
) -> JoinResponse:
    """LiveKit トークンと「join 済み」session token を発行する（発行ロジックの単一定義）。

    `join_session`（ログイン済み）とゲスト join（`join_product`）が共用し、
    トークン発行の二重化を防ぐ。metadata の sub は出所メタの正: ログイン済みは
    検証済み Google sub、ゲストは発番した `guest:{random}`（users/{sub} は作らない / 決定2）。
    """
    metadata = json.dumps({"role": role, "sub": sub, "email": email})
    try:
        token = (
            api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name(display_name)
            .with_metadata(metadata)
            .with_ttl(timedelta(minutes=settings.livekit_token_ttl_minutes))
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=session_id,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )
    except Exception as exc:  # pragma: no cover
        log.error("token_issue_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="failed to issue token") from exc

    session_token = create_session_token(
        session_id,
        sub,
        role,
        settings.session_signing_secret,
        ttl_seconds=settings.livekit_token_ttl_minutes * 60,
    )
    return JoinResponse(
        token=token,
        livekit_url=settings.livekit_url,
        session_id=session_id,
        identity=identity,
        session_token=session_token,
    )


class SelectRepoRequest(BaseModel):
    repo: str
    branch: str | None = None


class SessionGitHubResponse(BaseModel):
    repo: str | None = None
    branch: str | None = None
    commit_sha: str | None = None
    status: str = "none"
