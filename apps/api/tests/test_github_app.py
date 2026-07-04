"""Unit tests for the pure GitHub App linking helpers (ADR-0028).

No network: state signing, App JWT, secret redaction, relevance/size selection,
and summary assembly are all exercised in-memory.
"""

from __future__ import annotations

import time

import pytest

from sanba_api.github_app import (
    IndexFile,
    InvalidLinkState,
    build_app_jwt,
    build_app_jwt_claims,
    build_repo_summary,
    create_link_state,
    is_excluded_path,
    redact_secrets,
    repo_source_name,
    select_indexable_files,
    verify_link_state,
)

SECRET = "test-signing-secret"


# ── state 署名 ────────────────────────────────────────────────────────────
def test_link_state_roundtrip() -> None:
    token = create_link_state("user-123", SECRET)
    assert verify_link_state(token, SECRET) == "user-123"


def test_link_state_rejects_tamper() -> None:
    token = create_link_state("user-123", SECRET)
    payload, _sig = token.split(".", 1)
    forged = f"{payload}.deadbeef"
    with pytest.raises(InvalidLinkState):
        verify_link_state(forged, SECRET)


def test_link_state_rejects_wrong_secret() -> None:
    token = create_link_state("user-123", SECRET)
    with pytest.raises(InvalidLinkState):
        verify_link_state(token, "other-secret")


def test_link_state_rejects_expired() -> None:
    token = create_link_state("user-123", SECRET, ttl_seconds=-1)
    with pytest.raises(InvalidLinkState):
        verify_link_state(token, SECRET)


def test_link_state_rejects_malformed() -> None:
    with pytest.raises(InvalidLinkState):
        verify_link_state("not-a-token", SECRET)


# ── App JWT ───────────────────────────────────────────────────────────────
def test_app_jwt_claims_bounds() -> None:
    now = 1_700_000_000
    claims = build_app_jwt_claims("12345", now)
    assert claims["iss"] == "12345"
    assert claims["iat"] == now - 60
    # GitHub は 10 分上限。9 分に収める。
    assert claims["exp"] - claims["iat"] < 10 * 60


def test_app_jwt_signs_and_verifies_with_rsa() -> None:
    import jwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    now = int(time.time())
    token = build_app_jwt("app-1", private_pem, now)
    decoded = jwt.decode(token, public_pem, algorithms=["RS256"])
    assert decoded["iss"] == "app-1"


# ── 秘匿レダクト ──────────────────────────────────────────────────────────
# テスト用のダミー秘匿値は実行時に組み立てる（リテラルを置かない＝gitleaks を素通り
# させず、かつソースに偽トークンを残さない）。
def test_redact_github_token() -> None:
    fake_token = "ghp_" + "A" * 36
    out = redact_secrets(f"token = {fake_token}")
    assert fake_token not in out
    assert "redacted" in out


def test_redact_openai_hyphenated_token() -> None:
    # sk-proj-… / sk-svcacct-… のような hyphen 入り現行 OpenAI 形式も値全体を伏せる。
    fake = "sk-proj-" + "A" * 32
    out = redact_secrets(f"key {fake} end")
    assert fake not in out
    assert "redacted" in out


def test_redact_assignment_keeps_key_hides_value() -> None:
    fake_value = "s" * 24
    out = redact_secrets(f'api_key = "{fake_value}"')
    assert "api_key" in out
    assert fake_value not in out


def test_redact_private_key_block() -> None:
    # 実鍵を実行時に生成して PEM 化する（リテラルの鍵ブロックをソースに置かない）。
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    body = pem.splitlines()[1]  # base64 本文の一部
    out = redact_secrets(f"key:\n{pem}\n")
    assert body not in out
    assert "PRIVATE KEY" not in out


def test_redact_noop_on_clean_code() -> None:
    code = "def add(a, b):\n    return a + b\n"
    assert redact_secrets(code) == code


# ── 索引対象の除外/選別 ──────────────────────────────────────────────────
@pytest.mark.parametrize(
    "path",
    [
        "node_modules/react/index.js",
        "apps/web/dist/bundle.js",
        "package-lock.json",
        "uv.lock",
        ".env",
        ".env.production",
        "assets/logo.png",
        "vendor/lib.go",
        # minified/bundled は dist 配下でなくても suffix で弾く（拡張子は js/css）。
        "public/app.min.js",
        "static/styles.min.css",
        "src/main.js.map",
    ],
)
def test_is_excluded_path_true(path: str) -> None:
    assert is_excluded_path(path) is True


@pytest.mark.parametrize(
    "path",
    ["src/main.py", "README.md", "docs/adr/0001.md", "apps/api/config.py"],
)
def test_is_excluded_path_false(path: str) -> None:
    assert is_excluded_path(path) is False


def test_select_prioritizes_high_value_and_docs() -> None:
    files = [
        IndexFile("src/util.py", 100),
        IndexFile("README.md", 100),
        IndexFile("docs/design.md", 100),
    ]
    res = select_indexable_files(files, max_files=10, max_total_bytes=10_000, max_file_bytes=10_000)
    paths = [f.path for f in res.selected]
    assert paths[0] == "README.md"
    assert paths[1] == "docs/design.md"
    assert paths[2] == "src/util.py"


def test_select_applies_total_cap_and_marks_partial() -> None:
    files = [IndexFile(f"src/f{i}.py", 100) for i in range(10)]
    res = select_indexable_files(files, max_files=10, max_total_bytes=350, max_file_bytes=10_000)
    assert len(res.selected) == 3  # 3*100 <= 350, 4th would exceed
    assert res.truncated is True
    assert len(res.skipped_over_cap) == 7


def test_select_drops_excluded_and_too_large() -> None:
    files = [
        IndexFile("src/keep.py", 100),
        IndexFile("node_modules/x.js", 100),
        IndexFile("src/huge.py", 999_999),
    ]
    res = select_indexable_files(files, max_files=10, max_total_bytes=10_000, max_file_bytes=1000)
    assert [f.path for f in res.selected] == ["src/keep.py"]
    assert res.skipped_excluded == ["node_modules/x.js"]
    assert res.skipped_too_large == ["src/huge.py"]


def test_select_max_files_cap() -> None:
    files = [IndexFile(f"src/f{i}.py", 1) for i in range(5)]
    res = select_indexable_files(files, max_files=2, max_total_bytes=10_000, max_file_bytes=10_000)
    assert len(res.selected) == 2
    assert res.truncated is True


# ── 要約のシード ──────────────────────────────────────────────────────────
def test_build_repo_summary_contains_fields() -> None:
    summary = build_repo_summary(
        repo="octo/demo",
        branch="main",
        description="A demo app",
        primary_language="Python",
        readme="Hello world readme.",
        top_level_paths=["src", "docs", "README.md"],
    )
    assert "octo/demo" in summary
    assert "main" in summary
    assert "A demo app" in summary
    assert "Python" in summary
    assert "Hello world readme." in summary


def test_build_repo_summary_truncates() -> None:
    summary = build_repo_summary(
        repo="octo/demo",
        branch="main",
        description=None,
        primary_language=None,
        readme="x" * 5000,
        top_level_paths=[],
        max_chars=200,
    )
    assert len(summary) <= 201  # 200 + ellipsis
    assert summary.endswith("…")


def test_repo_source_name_embeds_repo_branch_sha_path() -> None:
    assert (
        repo_source_name("o/r", "main", "abc123", "src/a.py") == "github:o/r@main@abc123:src/a.py"
    )
