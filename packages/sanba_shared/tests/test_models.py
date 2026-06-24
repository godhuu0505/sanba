"""共有モデルの単体テスト: 既定値・旧データフォールバック・出所メタ保全。"""

from __future__ import annotations

from sanba_shared.models import (
    Priority,
    Requirement,
    RequirementCategory,
    RequirementStatus,
    SessionMeta,
)


def test_requirement_defaults_to_draft() -> None:
    req = Requirement(id="r1", category=RequirementCategory.FUNCTIONAL, statement="x")
    assert req.status is RequirementStatus.DRAFT
    assert req.approved_by is None
    assert req.approved_at is None
    assert req.priority is Priority.SHOULD


def test_legacy_requirement_without_status_falls_back_to_draft() -> None:
    # status フィールドを持たない旧 Firestore 文書を読み込むケース。
    legacy = {
        "id": "r-old",
        "category": "functional",
        "statement": "古い要件",
        "priority": "must",
        "confidence": 0.9,
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    req = Requirement.model_validate(legacy)
    assert req.status is RequirementStatus.DRAFT


def test_session_meta_roundtrips_through_json() -> None:
    meta = SessionMeta(
        id="sess-1",
        title="要件インタビュー",
        owner_sub="sub-123",
        owner_email="owner@example.com",
        roles=["pm", "engineer"],
    )
    restored = SessionMeta.model_validate(meta.model_dump(mode="json"))
    assert restored == meta
    assert restored.status == "active"
