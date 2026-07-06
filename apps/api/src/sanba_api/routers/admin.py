"""管理者ルート（/api/admin/*。main.py から分割 / 挙動不変）。"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sanba_shared.models import Requirement, RequirementStatus, SessionMeta
from sanba_shared.repository import RequirementNotFound

from ..auth_google import AuthUser, require_admin
from ..deps import _repo

log = structlog.get_logger(__name__)

router = APIRouter()


# ---- Admin: 運用画面 (ADR-0014) -------------------------------------------
# すべて require_admin でガードする。閲覧は requirements のみ。生の発話 (utterances) は
# プライバシー方針 (issue #10 / ADR-0014 §3) のため一切返さない。


class AdminSessionSummary(SessionMeta):
    """管理者セッション一覧用レスポンスモデル。

    SessionMeta の射影。goal/goal_detail（準備フォームの自由記述・PII可）は
    管理一覧に不要なため除外する（Codex comment 3524421531 対応）。
    """

    goal: str | None = Field(default=None, exclude=True)
    goal_detail: str | None = Field(default=None, exclude=True)


class UpdateRequirementRequest(BaseModel):
    """要件の編集/承認リクエスト。

    statement/priority/category は上書き (None は据え置き)。出所メタは変更できない (§10)。
    status を指定すると承認/却下/差し戻しを行う (§11)。両方を一度に指定してもよい。
    """

    statement: str | None = None
    priority: str | None = None
    category: str | None = None
    status: RequirementStatus | None = None


@router.get("/api/admin/sessions", response_model=list[AdminSessionSummary])
def admin_list_sessions(admin: AuthUser = Depends(require_admin)) -> list[SessionMeta]:
    """全セッションのメタ一覧 (MVP: ページングなし / ADR-0014 保留事項)。"""
    sessions = _repo.list_sessions()
    log.info("admin_list_sessions", admin=admin.email, count=len(sessions))
    return sessions


@router.get(
    "/api/admin/sessions/{session_id}/requirements",
    response_model=list[Requirement],
)
def admin_list_requirements(
    session_id: str, admin: AuthUser = Depends(require_admin)
) -> list[Requirement]:
    """セッションの要件一覧。発話 (utterances) は返さない。"""
    if _repo.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    reqs = _repo.list_requirements(session_id)
    log.info("admin_list_requirements", admin=admin.email, session=session_id, count=len(reqs))
    return reqs


@router.patch(
    "/api/admin/sessions/{session_id}/requirements/{rid}",
    response_model=Requirement,
)
def admin_update_requirement(
    session_id: str,
    rid: str,
    req: UpdateRequirementRequest,
    admin: AuthUser = Depends(require_admin),
) -> Requirement:
    """要件を編集・承認する (ADR-0014 §10,§11)。

    編集 (statement/priority/category) を先に適用してから status 遷移を行う。
    承認時は TTL を解除し成果物として保全する。
    """
    # セッション ID 誤りと要件 ID 誤りを区別する (admin_list_requirements と対称)。
    if _repo.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        if req.statement is not None or req.priority is not None or req.category is not None:
            current = _repo.update_requirement(
                session_id,
                rid,
                statement=req.statement,
                priority=req.priority,
                category=req.category,
            )
        else:
            found = _repo.get_requirement(session_id, rid)
            if found is None:
                raise RequirementNotFound(rid)
            current = found

        if req.status is not None:
            current = _repo.set_requirement_status(
                session_id, rid, req.status, approved_by=admin.email
            )
    except RequirementNotFound as exc:
        raise HTTPException(status_code=404, detail="requirement not found") from exc
    except ValueError as exc:
        # enum 不正など (priority/category の不正値) は 422 相当。
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    log.info(
        "admin_update_requirement",
        admin=admin.email,
        session=session_id,
        rid=rid,
        status=current.status,
    )
    return current
