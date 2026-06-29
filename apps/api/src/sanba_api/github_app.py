"""GitHub App per-user repo linking (ADR-0025).

Mirrors the philosophy of connectors/github.py: the security-critical *pure*
functions (state signing, App JWT claims, secret redaction, relevance-priority
selection with total-size caps, repo-summary assembly) are unit-tested without
any network. `GitHubAppClient` performs the actual REST calls (installation
tokens, repo/branch listing, tree/file/issue fetch) and is exercised only when
the App is configured.

Design choices encoded here:
- read-only access (Contents/Metadata/Issues); no write scope.
- raw installation tokens are never persisted; they are minted on demand from the
  App private key (see `_installation_token`).
- code bodies are redacted of secrets and filtered by relevance before indexing.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass, field

import structlog

log = structlog.get_logger(__name__)

_API = "https://api.github.com"

# ── state 署名（連携の CSRF/誤紐づけ対策・ADR-0025）────────────────────────────
# install フロー開始時に検証済み sub を署名 state に詰めて GitHub へ渡し、callback で
# 検証してから users/{sub} に保存する。auth.py の invite/session token と同じ HMAC 方式。

_LINK_SCOPE = "github-link"


class InvalidLinkState(Exception):
    """state が改竄/期限切れ/別スコープのときに送出する。"""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(payload_b64: str, secret: str) -> str:
    sig = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return _b64url_encode(sig)


def create_link_state(sub: str, secret: str, ttl_seconds: int = 600, *, nonce: str = "") -> str:
    """連携開始用の署名 state を発行する（sub に束縛、`ttl_seconds` 有効）。

    `nonce` は呼び出し側で乱数を与えると単発化できる（省略時は時刻で十分一意）。
    """
    payload = {
        "sub": sub,
        "scope": _LINK_SCOPE,
        "nonce": nonce or _b64url_encode(str(time.time_ns()).encode()),
        "exp": int(time.time()) + ttl_seconds,
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64, secret)}"


def verify_link_state(token: str, secret: str) -> str:
    """署名・期限・スコープを検証し、束縛された sub を返す。失敗時は InvalidLinkState。"""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError as exc:
        raise InvalidLinkState("malformed token") from exc

    expected = _sign(payload_b64, secret)
    if not hmac.compare_digest(sig, expected):
        raise InvalidLinkState("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise InvalidLinkState("malformed payload") from exc

    if payload.get("scope") != _LINK_SCOPE:
        raise InvalidLinkState("wrong scope")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise InvalidLinkState("expired")
    sub = payload.get("sub")
    if not sub:
        raise InvalidLinkState("missing sub")
    return str(sub)


# ── GitHub App 認証 JWT（RS256）─────────────────────────────────────────────


def build_app_jwt_claims(app_id: str, now: int) -> dict[str, object]:
    """App 認証 JWT のクレームを組む（純関数・テスト対象）。

    `iat` はクロックドリフト対策で 60 秒戻し、`exp` は GitHub 上限の 10 分未満（9 分）にする。
    """
    return {"iat": now - 60, "exp": now + 8 * 60, "iss": app_id}


def build_app_jwt(app_id: str, private_key_pem: str, now: int) -> str:
    """App 秘密鍵で署名した RS256 JWT を返す（installation token 取得に使う）。"""
    import jwt  # PyJWT[crypto]

    return jwt.encode(build_app_jwt_claims(app_id, now), private_key_pem, algorithm="RS256")


# ── コード索引前の秘匿レダクト（ADR-0025）──────────────────────────────────────
# gitleaks 相当の代表的なシークレットパターンをマスクしてから ES に入れる。完璧な検出は
# 目的ではなく、生のトークン/鍵が grounding 索引・検索結果に残らないようにする一次防御。

_REDACTED = "«redacted-secret»"

_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    # PEM private key blocks
    re.compile(r"-----BEGIN[A-Z ]*PRIVATE KEY-----.*?-----END[A-Z ]*PRIVATE KEY-----", re.DOTALL),
    # GitHub tokens (classic / fine-grained / oauth / app)
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    # AWS access key id
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    # Google API key
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}\b"),
    # Slack tokens
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    # OpenAI / generic sk- secrets（sk-proj-… / sk-svcacct-… 等 hyphen/underscore 含む形も）
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    # Bearer tokens in headers/config
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}"),
    # key/secret/password/token = "value" assignments
    re.compile(
        r"(?i)(api[_-]?key|secret|password|passwd|token|client[_-]?secret)"
        r"(\s*[:=]\s*)[\"']?[A-Za-z0-9._\-/+]{12,}[\"']?"
    ),
)


def redact_secrets(text: str) -> str:
    """text 中のシークレットらしき箇所をマスクする。検出ゼロなら原文を返す。"""
    redacted = text
    for pat in _SECRET_PATTERNS:
        if pat.groups >= 2:
            # 代入形は key と区切りを残し、値だけ伏せる（文脈は保ちつつ秘匿）。
            redacted = pat.sub(lambda m: f"{m.group(1)}{m.group(2)}{_REDACTED}", redacted)
        else:
            redacted = pat.sub(_REDACTED, redacted)
    return redacted


# ── 索引対象ファイルの関連度優先 + 総量キャップ（ADR-0025）──────────────────────

# 索引から除外するディレクトリ/拡張子（生成物・依存・binary・lockfile・秘匿）。
_EXCLUDED_DIR_PARTS = frozenset(
    {
        "node_modules",
        "vendor",
        "dist",
        "build",
        "out",
        ".next",
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        ".terraform",
        "target",
        "coverage",
    }
)
_EXCLUDED_BASENAMES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "uv.lock",
        "cargo.lock",
        "go.sum",
        "composer.lock",
        "gemfile.lock",
    }
)
_BINARY_EXTS = frozenset(
    {
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "ico",
        "svg",
        "pdf",
        "zip",
        "gz",
        "tar",
        "mp4",
        "mov",
        "mp3",
        "wav",
        "woff",
        "woff2",
        "ttf",
        "eot",
        "otf",
        "bin",
        "exe",
        "dll",
        "so",
        "dylib",
        "class",
        "jar",
        "wasm",
        "pyc",
        "lock",
        "map",
        "min.js",
    }
)
# 関連度の高い「説明系/設定系」ファイル。優先して索引する。
_HIGH_VALUE_BASENAMES = frozenset(
    {
        "readme",
        "readme.md",
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "go.mod",
        "cargo.toml",
        "pom.xml",
        "build.gradle",
        "dockerfile",
        "makefile",
        "openapi.yaml",
        "openapi.json",
        "schema.sql",
        "schema.prisma",
    }
)
_DOC_DIR_PARTS = frozenset({"docs", "doc", "adr", "rfc", "design"})


def is_excluded_path(path: str) -> bool:
    """生成物/依存/binary/lockfile/.env 等の索引除外パスか。"""
    lowered = path.lower()
    parts = lowered.split("/")
    base = parts[-1]
    if any(p in _EXCLUDED_DIR_PARTS for p in parts[:-1]):
        return True
    if base in _EXCLUDED_BASENAMES:
        return True
    if base == ".env" or base.startswith(".env."):
        return True
    # minified バンドルは拡張子が js/css になり _BINARY_EXTS の "min.js" 比較に当たらないため
    # suffix で別途弾く（圧縮済み巨大ファイルが総量 cap を食って通常ソースを押し出すのを防ぐ）。
    if base.endswith((".min.js", ".min.css", ".bundle.js", ".map")):
        return True
    if "." in base:
        ext = base.rsplit(".", 1)[1]
        if ext in _BINARY_EXTS:
            return True
    return False


def _relevance_rank(path: str) -> int:
    """小さいほど優先。説明/設定 > docs > 通常ソース。"""
    lowered = path.lower()
    base = lowered.split("/")[-1]
    if base in _HIGH_VALUE_BASENAMES or base.startswith("readme"):
        return 0
    if any(p in _DOC_DIR_PARTS for p in lowered.split("/")[:-1]):
        return 1
    return 2


@dataclass
class IndexFile:
    """索引候補ファイル（path と blob サイズ）。"""

    path: str
    size: int


@dataclass
class SelectionResult:
    """関連度優先 + キャップ適用の結果。`skipped_*` は UI/log で可視化する。"""

    selected: list[IndexFile] = field(default_factory=list)
    skipped_excluded: list[str] = field(default_factory=list)
    skipped_too_large: list[str] = field(default_factory=list)
    skipped_over_cap: list[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(f.size for f in self.selected)

    @property
    def truncated(self) -> bool:
        """総量キャップで一部を落としたか（=索引が PARTIAL になる）。"""
        return bool(self.skipped_over_cap)


def select_indexable_files(
    files: list[IndexFile],
    *,
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> SelectionResult:
    """関連度優先で索引対象を選び、ファイル数/総バイト/単一サイズの上限を適用する。

    優先順: 説明・設定系 > docs > 通常ソース。同順位内は安定（入力順）に保つ。除外・過大・
    キャップ超過は理由別に記録し、呼び出し側が log + UI へ出す（PARTIAL 表示の根拠）。
    """
    result = SelectionResult()
    candidates: list[IndexFile] = []
    for f in files:
        if is_excluded_path(f.path):
            result.skipped_excluded.append(f.path)
        elif f.size > max_file_bytes:
            result.skipped_too_large.append(f.path)
        else:
            candidates.append(f)

    # 安定ソート: 関連度ランク昇順。Python の sort は安定なので同順位は入力順を保つ。
    candidates.sort(key=lambda f: _relevance_rank(f.path))

    total = 0
    for f in candidates:
        if len(result.selected) >= max_files or total + f.size > max_total_bytes:
            result.skipped_over_cap.append(f.path)
            continue
        result.selected.append(f)
        total += f.size
    return result


# ── repo 要約のシード（機械的組み立て・ADR-0025）──────────────────────────────


def build_repo_summary(
    *,
    repo: str,
    branch: str,
    description: str | None,
    primary_language: str | None,
    readme: str | None,
    top_level_paths: list[str],
    max_chars: int = 2000,
) -> str:
    """agent 初期コンテキストへ差し込む repo 要約を機械的に組み立てる（LLM 不使用）。

    名/説明/branch/主要言語/トップ階層ツリー/README 先頭を決め打ちで連結し、`max_chars` で
    切る。retrieval 任せにせず「このセッションは repo X を前提にする」と明示する土台。
    """
    lines = [f"# 前提リポジトリ: {repo} (branch: {branch})"]
    if description:
        lines.append(f"説明: {description.strip()}")
    if primary_language:
        lines.append(f"主要言語: {primary_language}")
    if top_level_paths:
        shown = ", ".join(sorted(top_level_paths)[:40])
        lines.append(f"トップ階層: {shown}")
    if readme:
        head = readme.strip()
        lines.append("## README（抜粋）")
        lines.append(head)
    summary = "\n".join(lines).strip()
    if len(summary) > max_chars:
        summary = summary[:max_chars].rstrip() + "…"
    return summary


def repo_source_name(repo: str, branch: str, sha: str, path: str) -> str:
    """grounding 索引の出所名。`github:{repo}@{branch}@{sha}:{path}` で一意化する。

    sha を含めることで、repo を素早く選び直した際に残存し得る旧 commit の chunk を、
    検索側が現在の sha で峻別して除外できる（stale 索引の越境ヒット防止 / ADR-0025）。
    """
    return f"github:{repo}@{branch}@{sha}:{path}"


# ── 薄い GitHub App REST クライアント（App 設定時のみ使用）─────────────────────


@dataclass(frozen=True)
class RepoRef:
    """インストールが管理するリポジトリの最小情報。"""

    full_name: str  # "owner/name"
    default_branch: str
    private: bool


@dataclass(frozen=True)
class TreeListing:
    """ツリー取得結果。`truncated` は GitHub が再帰ツリーを打ち切ったとき True。

    打ち切られた場合は一部ファイルが欠落するため、索引は PARTIAL として扱う。
    """

    files: list[IndexFile]
    truncated: bool = False


def _parse_iso_epoch(value: object) -> float:
    """GitHub の expires_at(ISO8601) を epoch 秒へ。解釈不能なら 50 分後を仮定する。"""
    if isinstance(value, str):
        try:
            from datetime import datetime

            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return time.time() + 3000


class GitHubAppClient:  # pragma: no cover - network
    """installation token を都度発行して read-only に repo を読む薄いクライアント。"""

    def __init__(
        self,
        app_id: str,
        private_key_pem: str,
        oauth_client_id: str = "",
        oauth_client_secret: str = "",
    ) -> None:
        self.app_id = app_id
        self.private_key_pem = private_key_pem
        # user-to-server OAuth（install 時の所有権検証用 / ADR-0025・Codex P1）。
        self.oauth_client_id = oauth_client_id
        self.oauth_client_secret = oauth_client_secret
        # installation token は短命だが 1h 有効。1 索引ジョブで 1500 ファイル取得しても
        # 毎回発行しないよう (token, expiry_epoch) をプロセス内キャッシュして再利用する。
        self._token_cache: dict[int, tuple[str, float]] = {}
        # ファイル取得のホットパス用の共有 HTTP クライアント（接続プール再利用 / Codex P2）。
        # 1500 ファイルで TLS を都度確立しないよう lazy 生成し、ジョブ終了時に close する。
        self._http: object | None = None

    @property
    def oauth_configured(self) -> bool:
        """user-to-server OAuth による所有権検証が可能な構成か。"""
        return bool(self.oauth_client_id and self.oauth_client_secret)

    def user_owns_installation(self, code: str, installation_id: int) -> bool:
        """install 時の OAuth code から user token を得て、当該 installation を保有するか検証する。

        別人が他者の installation_id を署名 state と組み合わせて横取りするのを防ぐ
        （ADR-0025・Codex P1）。OAuth 未設定なら呼ばれない前提。
        """
        import httpx

        with httpx.Client(timeout=15) as client:
            tok = client.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                data={
                    "client_id": self.oauth_client_id,
                    "client_secret": self.oauth_client_secret,
                    "code": code,
                },
            )
            tok.raise_for_status()
            user_token = tok.json().get("access_token")
            if not user_token:
                return False
            headers = {
                "Authorization": f"Bearer {user_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            }
            page = 1
            while True:
                res = client.get(
                    f"{_API}/user/installations",
                    headers=headers,
                    params={"per_page": 100, "page": page},
                )
                res.raise_for_status()
                data = res.json()
                installs = data.get("installations", [])
                if any(int(i.get("id", -1)) == installation_id for i in installs):
                    return True
                if len(installs) < 100:
                    return False
                page += 1

    def _app_headers(self) -> dict[str, str]:
        token = build_app_jwt(self.app_id, self.private_key_pem, int(time.time()))
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _installation_token(self, installation_id: int) -> str:
        """短命の installation token を発行/再利用する（保存はしない・期限手前で失効）。"""
        import httpx

        cached = self._token_cache.get(installation_id)
        if cached is not None and cached[1] - 300 > time.time():
            return cached[0]
        with httpx.Client(timeout=15) as client:
            res = client.post(
                f"{_API}/app/installations/{installation_id}/access_tokens",
                headers=self._app_headers(),
            )
        res.raise_for_status()
        body = res.json()
        token = str(body["token"])
        expiry = _parse_iso_epoch(body.get("expires_at"))
        self._token_cache[installation_id] = (token, expiry)
        return token

    def _inst_headers(self, installation_id: int) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._installation_token(installation_id)}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def list_repos(self, installation_id: int) -> list[RepoRef]:
        """インストールがアクセスを許可した repo 一覧（owner が準備画面で選ぶ母集合）。"""
        import httpx

        repos: list[RepoRef] = []
        headers = self._inst_headers(installation_id)
        with httpx.Client(timeout=15) as client:
            page = 1
            while True:
                res = client.get(
                    f"{_API}/installation/repositories",
                    headers=headers,
                    params={"per_page": 100, "page": page},
                )
                res.raise_for_status()
                data = res.json()
                for r in data.get("repositories", []):
                    repos.append(
                        RepoRef(
                            full_name=r["full_name"],
                            default_branch=r.get("default_branch", "main"),
                            private=bool(r.get("private", True)),
                        )
                    )
                if len(repos) >= int(data.get("total_count", 0)) or not data.get("repositories"):
                    break
                page += 1
        return repos

    def list_branches(self, installation_id: int, repo: str) -> list[dict[str, str]]:
        """repo の branch 一覧（name + head sha）。準備画面の branch 選択に使う。"""
        import httpx

        branches: list[dict[str, str]] = []
        headers = self._inst_headers(installation_id)
        with httpx.Client(timeout=15) as client:
            page = 1
            while True:
                res = client.get(
                    f"{_API}/repos/{repo}/branches",
                    headers=headers,
                    params={"per_page": 100, "page": page},
                )
                res.raise_for_status()
                data = res.json()
                if not data:
                    break
                for b in data:
                    branches.append({"name": b["name"], "sha": b["commit"]["sha"]})
                if len(data) < 100:
                    break
                page += 1
        return branches

    def repo_meta(self, installation_id: int, repo: str) -> dict[str, object]:
        """repo の description / language / default_branch 等。"""
        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.get(f"{_API}/repos/{repo}", headers=self._inst_headers(installation_id))
        res.raise_for_status()
        data = res.json()
        return {
            "description": data.get("description"),
            "language": data.get("language"),
            "default_branch": data.get("default_branch", "main"),
        }

    def branch_head_sha(self, installation_id: int, repo: str, branch: str) -> str:
        """branch の HEAD commit sha（索引のピン留め基準）。

        `feature/foo` のような slash を含む branch 名でも 404 にならないよう、branch を
        単一 path セグメントとしてエンコードする。
        """
        from urllib.parse import quote

        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.get(
                f"{_API}/repos/{repo}/branches/{quote(branch, safe='')}",
                headers=self._inst_headers(installation_id),
            )
        res.raise_for_status()
        return str(res.json()["commit"]["sha"])

    def list_tree(self, installation_id: int, repo: str, sha: str) -> TreeListing:
        """commit sha の全ツリーを再帰取得し、blob を (path, size) で返す。

        Get-a-tree は tree SHA を要求するため、まず commit を解決して tree SHA を得てから
        取得する（commit SHA を直接渡すと環境により 404 になりうるため確実な経路にする）。
        再帰ツリーが GitHub 側で打ち切られた場合は `truncated=True` を返し、索引を PARTIAL にする。
        """
        import httpx

        headers = self._inst_headers(installation_id)
        with httpx.Client(timeout=30) as client:
            commit = client.get(f"{_API}/repos/{repo}/git/commits/{sha}", headers=headers)
            commit.raise_for_status()
            tree_sha = commit.json()["tree"]["sha"]
            res = client.get(
                f"{_API}/repos/{repo}/git/trees/{tree_sha}",
                headers=headers,
                params={"recursive": "1"},
            )
        res.raise_for_status()
        data = res.json()
        files: list[IndexFile] = []
        for node in data.get("tree", []):
            if node.get("type") == "blob":
                files.append(IndexFile(path=node["path"], size=int(node.get("size", 0))))
        truncated = bool(data.get("truncated"))
        if truncated:
            log.warning("repo_tree_truncated", repo=repo, sha=sha, files=len(files))
        return TreeListing(files=files, truncated=truncated)

    def _shared_http(self):  # type: ignore[no-untyped-def]
        """ファイル取得のホットパス用の共有 httpx.Client（接続プール再利用 / Codex P2）。"""
        import httpx

        if self._http is None:
            self._http = httpx.Client(timeout=15)
        return self._http

    def close(self) -> None:
        """共有 HTTP クライアントを閉じる（索引ジョブ終了時に呼ぶ）。"""
        if self._http is not None:
            self._http.close()  # type: ignore[attr-defined]
            self._http = None

    def fetch_file(self, installation_id: int, repo: str, sha: str, path: str) -> str:
        """1 ファイルを raw 取得する（テキスト前提）。

        `docs/a#b.md` や `a?b.txt` のような Git では有効なファイル名で `#`/`?` が
        fragment/query として切られないよう、path セグメントとしてエンコードする。
        接続確立コストを抑えるため、索引ジョブ内で共有の httpx.Client を再利用する。
        """
        from urllib.parse import quote

        res = self._shared_http().get(
            f"{_API}/repos/{repo}/contents/{quote(path, safe='/')}",
            headers={
                **self._inst_headers(installation_id),
                "Accept": "application/vnd.github.raw+json",
            },
            params={"ref": sha},
        )
        res.raise_for_status()
        return res.text

    def fetch_readme(self, installation_id: int, repo: str, sha: str) -> str | None:
        """README 本文（無ければ None）。"""
        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.get(
                f"{_API}/repos/{repo}/readme",
                headers={
                    **self._inst_headers(installation_id),
                    "Accept": "application/vnd.github.raw+json",
                },
                params={"ref": sha},
            )
        if res.status_code == 200 and res.text:
            return res.text
        return None

    def fetch_issues(
        self, installation_id: int, repo: str, max_issues: int = 30
    ) -> list[dict[str, object]]:
        """直近の Issue を取得する（PR は除く。前提情報として索引する / ADR-0025 索引範囲）。"""
        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.get(
                f"{_API}/repos/{repo}/issues",
                headers=self._inst_headers(installation_id),
                params={"state": "all", "per_page": max_issues},
            )
        res.raise_for_status()
        # PR も /issues に含まれるため pull_request キーで除外する。
        return [i for i in res.json() if "pull_request" not in i]

    def installation_login(self, installation_id: int) -> str:
        """installation のアカウント login（連携表示用）。"""
        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.get(
                f"{_API}/app/installations/{installation_id}",
                headers=self._app_headers(),
            )
        res.raise_for_status()
        account = res.json().get("account") or {}
        return str(account.get("login", ""))
