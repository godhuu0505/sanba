"""FastAPI app: create sessions, issue invite-gated LiveKit tokens.

Access model:
  1. POST /api/sessions          -> owner creates a room, gets signed invites per role.
  2. POST /api/sessions/join     -> a guest exchanges a valid invite for a scoped,
                                    short-lived LiveKit token. Joining an arbitrary
                                    session_id without an invite is rejected.

The web client connects to LiveKit directly with the returned token; the voice
agent worker is dispatched to the same room name automatically.

本モジュールは薄い組み立て層のみを持つ: app 生成・join レートリミット middleware・
CORS・observability・ドメイン別ルータ（routers/*）の登録。各エンドポイントは
routers/{sessions,github_link,products,members,admin}.py、シングルトンと横断ヘルパは
deps.py に住む。
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import github_export
from .config import settings
from .deps import (
    _asset_store,
    _confirmed_requirements,
    _finalized_snapshot_requirements,
    _get_tracer,
    _github_repo_allowed,
    _indexer,
    _join_hits,
    _over_rate_limit,
    _read_repo,
    _repo,
    forbid_guest_writes,
    require_session_access,
)
from .observability import record_rate_limited, setup_observability
from .routers import admin, auth, github_link, members, products, sessions
from .routers.products import MAX_CHECK_ITEM_CHARS, MAX_OUTPUT_FORMAT_CHARS

# tests の後方互換の再エクスポート: 従来 `sanba_api.main` に住んでいた公開名を、同一
# オブジェクトのまま `main.X` / `from sanba_api.main import X` で参照できるように保つ
# （`_repo` 等のシングルトンは deps のインスタンスそのもの）。関数を monkeypatch する
# 場合は、この再エクスポートではなくその関数が住むモジュール（routers/* / deps）へ
# パッチすること。
__all__ = [
    "MAX_CHECK_ITEM_CHARS",
    "MAX_OUTPUT_FORMAT_CHARS",
    "app",
    "forbid_guest_writes",
    "github_export",
    "record_rate_limited",
    "require_session_access",
    "settings",
    "_asset_store",
    "_confirmed_requirements",
    "_finalized_snapshot_requirements",
    "_get_tracer",
    "_github_repo_allowed",
    "_indexer",
    "_join_hits",
    "_over_rate_limit",
    "_read_repo",
    "_repo",
]

log = structlog.get_logger(__name__)


app = FastAPI(title="SANBA API", version="0.2.0")


@app.middleware("http")
async def _rate_limit_join(request: Request, call_next: Any) -> Any:
    """join のレートリミットを body 解析より前（ミドルウェア層）で適用する。

    FastAPI ルートの依存性（Depends）は request body の読み取り・JSON/Pydantic 解析の後に
    解決される（routing.py: body→solve_dependencies の順）。そのため依存性版は、未認証
    スパムが壊れた/巨大 JSON を送ると解析コストだけを発生させ続けられる穴が残っていた。Starlette
    の HTTP ミドルウェアは body 読み取り前に走るので、POST /api/sessions/join のみ上限判定し、
    超過時は body に触れず 429 を返す。CORS より内側で動くよう CORS の前に登録し、429 応答にも
    CORS ヘッダが付くようにする（ミドルウェアは後から add した方が外側になる）。
    """
    # 深掘りリンク入場（/api/products/join）も同じ未認証スパム面を持つため同枠で制限する。
    if request.method == "POST" and request.url.path in (
        "/api/sessions/join",
        "/api/products/join",
    ):
        client_ip = request.client.host if request.client else "unknown"
        if _over_rate_limit(client_ip):
            # 認証より前に短絡するため auth イベントに現れない。DoS 緩和の発火をログ＋
            # メトリクスで本番検知できるようにする（CLAUDE.md 原則3）。
            log.warning(
                "join_rate_limited", client_ip=client_ip, limit=settings.join_rate_per_minute
            )
            record_rate_limited()
            return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
# OTLP エンドポイントが設定されていれば分散トレースを有効化する (未設定なら no-op)。
setup_observability(app)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ドメイン別ルータの登録。各エンドポイントのパス・認可・response_model は移設前のまま。
app.include_router(auth.router)
app.include_router(sessions.router)
app.include_router(github_link.router)
app.include_router(products.router)
app.include_router(members.router)
app.include_router(admin.router)
