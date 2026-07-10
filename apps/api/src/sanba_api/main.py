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
routers/{sessions,github_link,products,members}.py、シングルトンと横断ヘルパは
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
from .routers import auth, github_link, members, products, sessions
from .routers import session as auth_session
from .routers.products import MAX_CHECK_ITEM_CHARS, MAX_OUTPUT_FORMAT_CHARS

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


_allowed_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

if "*" in _allowed_origins:
    raise RuntimeError("ALLOWED_ORIGINS='*' は allow_credentials=True と衝突する (ADR-0060)")

_unsafe_methods = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _rate_limit_key(request: Request) -> str:
    """レートリミットの実クライアント識別子を返す。

    `X-Forwarded-For` の**右端**（直近の信頼プロキシ = GCP フロントエンドが追記したホップ）を
    使う。クライアントが自ら詰めた偽装値は左側に残り右端には出ないため、キーを詐称して
    バケットを回避できない。XFF が無ければ実 TCP ピア（`request.client.host`）へフォールバック。
    多段 LB 配下では右端がフロントエンド IP に収束しうるが、その環境はエッジの Cloud Armor
    （実送信元 IP 単位のレート制限）を一次防御に据える。
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        client = forwarded.rsplit(",", 1)[-1].strip()
        if client:
            return client
    return request.client.host if request.client else "unknown"


app = FastAPI(title="SANBA API", version="0.2.0")


@app.middleware("http")
async def _enforce_origin_for_cookie_writes(request: Request, call_next: Any) -> Any:
    """Cookie 由来リクエストの CSRF 多層防御（ADR-0060 §4）。

    SameSite=Lax + 同一オリジン rewrites で構造的な CSRF 防御は成立しているが、
    Cookie を持つ unsafe method には `Origin` ヘッダが allowlist に一致することも
    要求する。Bearer 経路（Cookie を持たない）は無傷（server-to-server や外部連携が
    Origin を持たないことがあるため）。
    """
    if request.method in _unsafe_methods and request.cookies.get("sanba_sid"):
        origin = request.headers.get("origin", "")
        if origin not in _allowed_origins:
            log.warning("origin_rejected", origin=origin, path=request.url.path)
            return JSONResponse(status_code=403, content={"detail": "forbidden origin"})
    return await call_next(request)


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
    if request.method == "POST" and request.url.path in (
        "/api/sessions/join",
        "/api/products/join",
    ):
        client_ip = _rate_limit_key(request)
        if _over_rate_limit(client_ip):
            log.warning(
                "join_rate_limited", client_ip=client_ip, limit=settings.join_rate_per_minute
            )
            record_rate_limited()
            return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)
setup_observability(app)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(auth_session.router)
app.include_router(sessions.router)
app.include_router(github_link.router)
app.include_router(products.router)
app.include_router(members.router)
