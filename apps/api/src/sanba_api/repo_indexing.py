"""Repo -> Elasticsearch grounding indexing orchestration (ADR-0025).

Ties the pure selection/redaction helpers (github_app.py) to the existing
ContextIndexer pipeline. The network fetch is delegated to a small protocol so
the orchestration is unit-testable with a fake client (no GitHub, no ES).

Flow: list tree -> relevance-priority select under size caps -> fetch each blob
-> redact secrets -> chunk -> index into the session's grounding scope. The repo
summary is also indexed (and returned) so the agent can seed it as premise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import structlog

from .github_app import (
    IndexFile,
    TreeListing,
    build_repo_summary,
    redact_secrets,
    repo_source_name,
    select_indexable_files,
)
from .ingestion import ContextIndexer, chunk_text

log = structlog.get_logger(__name__)


class RepoFetcher(Protocol):
    """GitHub 取得の最小インターフェース（本番は GitHubAppClient、テストは fake）。"""

    def list_tree(self, installation_id: int, repo: str, sha: str) -> TreeListing:
        """branch head sha のツリー（path + blob size + truncated）を返す。"""
        ...

    def fetch_file(self, installation_id: int, repo: str, sha: str, path: str) -> str:
        """1 ファイルの内容（テキスト）を返す。"""
        ...

    def fetch_readme(self, installation_id: int, repo: str, sha: str) -> str | None:
        """README 本文（無ければ None）。"""
        ...

    def repo_meta(self, installation_id: int, repo: str) -> dict[str, object]:
        """description / language / default_branch 等のメタ。"""
        ...


@dataclass
class IndexOutcome:
    """索引結果。状態判定の根拠。

    - `partial`: 総量キャップ / ツリー打ち切り / 一部ファイル取得失敗 で一部が欠けたとき True。
    - `failed`: 索引すべき候補があったのに 1 件も取得できなかったとき True（要約しか入らない）。
    """

    indexed_files: int
    indexed_chunks: int
    skipped: int
    partial: bool
    failed: bool
    summary: str


def fetch_and_index_repo(
    fetcher: RepoFetcher,
    indexer: ContextIndexer,
    *,
    session_id: str,
    installation_id: int,
    repo: str,
    branch: str,
    commit_sha: str,
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> IndexOutcome:
    """repo を取得・秘匿レダクト・chunk して session の grounding 索引へ入れる。

    返り値の `summary` は agent の初期シード用（SessionMeta 経由で渡す土台）。
    """
    tree = fetcher.list_tree(installation_id, repo, commit_sha)
    selection = select_indexable_files(
        tree.files,
        max_files=max_files,
        max_total_bytes=max_total_bytes,
        max_file_bytes=max_file_bytes,
    )
    skipped = (
        len(selection.skipped_excluded)
        + len(selection.skipped_too_large)
        + len(selection.skipped_over_cap)
    )
    if skipped:
        log.info(
            "repo_index_selection",
            repo=repo,
            selected=len(selection.selected),
            skipped_excluded=len(selection.skipped_excluded),
            skipped_too_large=len(selection.skipped_too_large),
            skipped_over_cap=len(selection.skipped_over_cap),
        )

    meta = fetcher.repo_meta(installation_id, repo)
    readme = fetcher.fetch_readme(installation_id, repo, commit_sha)
    summary = build_repo_summary(
        repo=repo,
        branch=branch,
        description=_as_str(meta.get("description")),
        primary_language=_as_str(meta.get("language")),
        readme=readme,
        top_level_paths=_top_level_paths(selection.selected),
    )

    indexed_files = 0
    indexed_chunks = 0
    # 要約自体も索引する（search_grounding が「前提リポジトリ」を引けるように）。
    indexed_chunks += indexer.index_context(
        session_id, chunk_text(summary), repo_source_name(repo, branch, "_summary")
    )

    fetch_failures = 0
    for f in selection.selected:
        try:
            raw = fetcher.fetch_file(installation_id, repo, commit_sha, f.path)
        except Exception as exc:
            # 404/403/レート制限など。失敗は握り潰さず集計し、状態に反映する。
            fetch_failures += 1
            log.warning("repo_file_fetch_failed", repo=repo, path=f.path, error=str(exc))
            continue
        # コード中の生シークレットを索引前にレダクトする（PII マスクは indexer 側で並行）。
        safe = redact_secrets(raw)
        chunks = chunk_text(safe)
        if not chunks:
            continue
        indexed_chunks += indexer.index_context(
            session_id, chunks, repo_source_name(repo, branch, f.path)
        )
        indexed_files += 1

    # 選別段でキャップ/除外があった、ツリーが打ち切られた、取得に一部失敗した → PARTIAL。
    partial = selection.truncated or tree.truncated or fetch_failures > 0
    # 索引すべき候補があったのに 1 件も取得できなかった → FAILED（要約しか入っていない）。
    failed = bool(selection.selected) and indexed_files == 0
    outcome = IndexOutcome(
        indexed_files=indexed_files,
        indexed_chunks=indexed_chunks,
        skipped=skipped,
        partial=partial,
        failed=failed,
        summary=summary,
    )
    log.info(
        "repo_indexed",
        repo=repo,
        branch=branch,
        sha=commit_sha,
        files=indexed_files,
        chunks=indexed_chunks,
        fetch_failures=fetch_failures,
        tree_truncated=tree.truncated,
        partial=partial,
        failed=failed,
    )
    return outcome


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _top_level_paths(files: list[IndexFile]) -> list[str]:
    """選別済みファイルからトップ階層のディレクトリ/ファイル名集合を作る（要約用）。"""
    tops: set[str] = set()
    for f in files:
        head = f.path.split("/", 1)[0]
        tops.add(head)
    return sorted(tops)
