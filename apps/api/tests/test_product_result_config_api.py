"""要件結果の出力フォーマット / 確認項目 API のテスト。

- PATCH /api/products/{id}: output_formats（audience 検証・空値＝既定へ戻す・過長 400）と
  check_items（最大 10・正規化・重複除去）の更新。
- GET /api/products/{id}: 登録値と既定テンプレート（output_format_defaults）の応答。
- GET /api/sessions/mine/{id}/result-document: audience 別整形・既定フォールバック・
  本人限定 404。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import Product, SessionMeta
from sanba_shared.output_formats import DEFAULT_OUTPUT_FORMATS

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import MAX_CHECK_ITEM_CHARS, MAX_OUTPUT_FORMAT_CHARS, _read_repo, _repo, app

client = TestClient(app)
OWNER = "owner-sub"


def _user(sub: str, email: str = "u@example.com") -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    _repo._mem_products.clear()
    _repo._mem_sessions.clear()
    _read_repo._mem_requirements.clear()
    assert _repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)


def _seed_product(pid: str = "prod-1", owner: str = OWNER) -> None:
    _repo.create_product(Product(id=pid, name="請求アプリ", owner_sub=owner))


def _seed_session(
    sid: str = "sess-1",
    owner: str = OWNER,
    *,
    product_id: str | None = None,
    goal: str | None = None,
) -> None:
    _repo.create_session_doc(
        SessionMeta(
            id=sid,
            title="請求の深掘り",
            owner_sub=owner,
            owner_email=f"{owner}@example.com",
            product_id=product_id,
            goal=goal,
            created_at=datetime(2026, 7, 1, tzinfo=UTC),
        )
    )


def _seed_requirement(sid: str, rid: str = "r1", statement: str = "CSV を出力できる") -> None:
    _read_repo._seed_requirement(
        sid,
        {
            "id": rid,
            "statement": statement,
            "category": "functional",
            "priority": "must",
            "confidence": 0.9,
            "source_speaker": "顧客",
        },
    )


# ---- PATCH: 出力フォーマットの登録 ------------------------------------------
def test_patch_output_formats_registers_per_audience() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch(
        "/api/products/prod-1",
        json={"output_formats": {"developer": "# 独自開発者向け\n{{requirements}}"}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["output_formats"] == {"developer": "# 独自開発者向け\n{{requirements}}"}
    # 既定テンプレートは常に 3 audience 分返る（web の「未登録＝この既定」表示用）。
    assert set(body["output_format_defaults"]) == {"end_user", "planner", "developer"}


def test_patch_output_formats_blank_value_resets_to_default() -> None:
    _seed_product()
    _login(OWNER)
    client.patch("/api/products/prod-1", json={"output_formats": {"planner": "# 独自"}})
    # 空文字（空白のみ）で送ると登録が消え、既定フォールバックに戻る。
    body = client.patch("/api/products/prod-1", json={"output_formats": {"planner": "   "}}).json()
    assert body["output_formats"] == {}


def test_patch_output_formats_rejects_unknown_audience_as_400() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch("/api/products/prod-1", json={"output_formats": {"manager": "# x"}})
    assert res.status_code == 400
    assert "unknown audience" in res.json()["detail"]


def test_patch_output_formats_rejects_too_long_template_as_400() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch(
        "/api/products/prod-1",
        json={"output_formats": {"developer": "x" * (MAX_OUTPUT_FORMAT_CHARS + 1)}},
    )
    assert res.status_code == 400


# ---- PATCH: 確認項目の登録 ---------------------------------------------------
def test_patch_check_items_normalizes_and_saves() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch(
        "/api/products/prod-1",
        json={"check_items": [" ログイン方式 ", "", "課金の有無", "ログイン方式"]},
    )
    assert res.status_code == 200, res.text
    # strip・空要素除去・順序を保った重複除去。
    assert res.json()["check_items"] == ["ログイン方式", "課金の有無"]


def test_patch_check_items_rejects_more_than_ten_as_422() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch(
        "/api/products/prod-1", json={"check_items": [f"項目{i}" for i in range(11)]}
    )
    assert res.status_code == 422  # Pydantic の max_length（要求仕様: 最大 10 個）


def test_patch_check_items_accepts_exactly_ten() -> None:
    _seed_product()
    _login(OWNER)
    items = [f"項目{i}" for i in range(10)]
    res = client.patch("/api/products/prod-1", json={"check_items": items})
    assert res.status_code == 200
    assert res.json()["check_items"] == items


def test_patch_check_items_rejects_too_long_item_as_400() -> None:
    _seed_product()
    _login(OWNER)
    res = client.patch(
        "/api/products/prod-1", json={"check_items": ["x" * (MAX_CHECK_ITEM_CHARS + 1)]}
    )
    assert res.status_code == 400


def test_patch_result_config_is_owner_only() -> None:
    """メンバー・非関係者は更新できない（管理操作 / ADR-0036 の manage=True と同じ倒し方）。"""
    _seed_product()
    _login("intruder")
    res = client.patch("/api/products/prod-1", json={"check_items": ["x"]})
    assert res.status_code == 404  # 非関係者は存在秘匿の 404


def test_get_product_returns_result_config_fields() -> None:
    _seed_product()
    _login(OWNER)
    body = client.get("/api/products/prod-1").json()
    assert body["output_formats"] == {}
    assert body["check_items"] == []
    assert set(body["output_format_defaults"]) == {"end_user", "planner", "developer"}


# ---- GET /api/sessions/mine/{id}/result-document -----------------------------
def _get_document(sid: str, audience: str) -> Any:
    return client.get(f"/api/sessions/mine/{sid}/result-document", params={"audience": audience})


def test_result_document_uses_default_format_when_unset() -> None:
    _seed_product()
    _seed_session(product_id="prod-1", goal="請求業務を自動化する")
    _seed_requirement("sess-1")
    _login(OWNER)

    res = _get_document("sess-1", "developer")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["audience"] == "developer"
    assert body["is_custom_format"] is False
    # 既定テンプレートの章立て・要件・メタが埋まっている。
    assert "要件定義書（開発者向け）: 請求の深掘り" in body["markdown"]
    assert "請求アプリ" in body["markdown"]
    assert "請求業務を自動化する" in body["markdown"]
    assert "- [functional] CSV を出力できる" in body["markdown"]


def test_result_document_uses_registered_format_per_audience() -> None:
    _seed_product()
    _seed_session(product_id="prod-1")
    _seed_requirement("sess-1")
    _login(OWNER)
    client.patch(
        "/api/products/prod-1",
        json={
            "output_formats": {"planner": "# 企画レビュー用\n{{requirements}}"},
            "check_items": ["課金の有無"],
        },
    )

    planner = _get_document("sess-1", "planner").json()
    assert planner["is_custom_format"] is True
    assert planner["markdown"].startswith("# 企画レビュー用")
    # 登録していない audience は既定のまま（1 audience 1 フォーマット）。
    developer = _get_document("sess-1", "developer").json()
    assert developer["is_custom_format"] is False
    assert "要件定義書（開発者向け）" in developer["markdown"]
    assert "- 課金の有無" in developer["markdown"]  # 確認項目も文書に載る


def test_result_document_end_user_hides_dev_vocabulary() -> None:
    _seed_product()
    _seed_session(product_id="prod-1")
    _seed_requirement("sess-1", statement="ボタンが見つけやすくなる")
    _login(OWNER)

    body = _get_document("sess-1", "end_user").json()
    assert "- ボタンが見つけやすくなる" in body["markdown"]
    assert "MoSCoW" not in body["markdown"]
    assert "functional" not in body["markdown"]


def test_result_document_works_for_standalone_session() -> None:
    """product 未従属の単発セッションでも既定フォーマットで生成できる。"""
    _seed_session()
    _seed_requirement("sess-1")
    _login(OWNER)

    body = _get_document("sess-1", "developer").json()
    assert body["is_custom_format"] is False
    assert "（未設定）" in body["markdown"]  # app_name のフォールバック


def test_result_document_finalized_uses_frozen_snapshot() -> None:
    """確定済みは絵巻閲覧（mine/{id}/requirements）と同じ凍結スナップショットを整形する。"""
    _seed_session()
    _seed_requirement("sess-1", "r1", statement="確定分")
    _repo.finalize_session("sess-1", confirmed_count=1, finalized_requirement_ids=["r1"])
    _seed_requirement("sess-1", "r2", statement="確定後の遅延追加")
    _login(OWNER)

    body = _get_document("sess-1", "developer").json()
    assert "確定分" in body["markdown"]
    assert "確定後の遅延追加" not in body["markdown"]


def test_result_document_rejects_unknown_audience_as_422() -> None:
    _seed_session()
    _login(OWNER)
    assert _get_document("sess-1", "manager").status_code == 422


def test_result_document_hides_other_owners_session_as_404() -> None:
    _seed_session("sess-bob", "bob")
    _login("alice")
    assert _get_document("sess-bob", "developer").status_code == 404


def test_result_document_default_templates_match_shared_constants() -> None:
    """API が返す既定テンプレートは sanba_shared の定数と一致する（web 表示用の参照値）。"""
    _seed_product()
    _login(OWNER)
    body = client.get("/api/products/prod-1").json()
    for audience, template in DEFAULT_OUTPUT_FORMATS.items():
        assert body["output_format_defaults"][audience.value] == template
