"""Orchestration test for repo -> grounding indexing (ADR-0025).

Uses a fake fetcher + the in-memory ContextIndexer (no GitHub, no Elasticsearch).
"""

from __future__ import annotations

from sanba_api.github_app import IndexFile, TreeListing
from sanba_api.ingestion import ContextIndexer
from sanba_api.repo_indexing import fetch_and_index_repo


class FakeFetcher:
    def __init__(
        self, files: dict[str, str], *, truncated: bool = False, fail_paths: set[str] | None = None
    ) -> None:
        self._files = files
        self._truncated = truncated
        self._fail_paths = fail_paths or set()

    def list_tree(self, installation_id: int, repo: str, sha: str) -> TreeListing:
        files = [IndexFile(p, len(c.encode())) for p, c in self._files.items()]
        return TreeListing(files=files, truncated=self._truncated)

    def _maybe_fail(self, path: str) -> None:
        if path in self._fail_paths:
            raise RuntimeError("simulated fetch failure")

    def fetch_file(self, installation_id: int, repo: str, sha: str, path: str) -> str:
        self._maybe_fail(path)
        return self._files[path]

    def fetch_readme(self, installation_id: int, repo: str, sha: str) -> str | None:
        return self._files.get("README.md")

    def repo_meta(self, installation_id: int, repo: str) -> dict[str, object]:
        return {"description": "demo", "language": "Python", "default_branch": "main"}


def _index() -> ContextIndexer:
    idx = ContextIndexer()
    assert idx.is_memory, "テストは ES 非接続のメモリ fallback 前提"
    return idx


def test_index_repo_indexes_files_and_summary() -> None:
    fetcher = FakeFetcher(
        {
            "README.md": "# Demo\nThis is a demo project.",
            "src/main.py": "def main():\n    return 1\n",
            "node_modules/dep.js": "console.log('skip me')",
        }
    )
    indexer = _index()
    outcome = fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-1",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=100,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    # README + src/main.py が索引され、node_modules は除外される。
    assert outcome.indexed_files == 2
    assert outcome.indexed_chunks > 0
    assert outcome.skipped == 1
    assert outcome.partial is False
    assert "octo/demo" in outcome.summary
    assert "This is a demo project." in outcome.summary


def test_index_repo_redacts_secrets_before_indexing() -> None:
    # ダミートークンは実行時に組み立てる（ソースにリテラルを残さない）。
    fake_token = "ghp_" + "A" * 36
    fetcher = FakeFetcher({"config.py": f'API_KEY = "{fake_token}"\n'})
    indexer = _index()
    fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-2",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=100,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    # in-memory 索引に生トークンが残っていないこと。
    blob = " ".join(d["text"] for d in indexer._mem)
    assert fake_token not in blob


def test_index_repo_marks_partial_on_cap() -> None:
    fetcher = FakeFetcher({f"src/f{i}.py": "x" * 100 for i in range(10)})
    indexer = _index()
    outcome = fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-3",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=3,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    assert outcome.indexed_files == 3
    assert outcome.partial is True


def test_index_repo_truncated_tree_marks_partial() -> None:
    fetcher = FakeFetcher({"src/a.py": "x = 1\n"}, truncated=True)
    indexer = _index()
    outcome = fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-t",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=100,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    assert outcome.partial is True
    assert outcome.failed is False


def test_index_repo_partial_fetch_failure_marks_partial() -> None:
    fetcher = FakeFetcher(
        {"src/a.py": "x = 1\n", "src/b.py": "y = 2\n"}, fail_paths={"src/b.py"}
    )
    indexer = _index()
    outcome = fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-pf",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=100,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    assert outcome.indexed_files == 1
    assert outcome.partial is True
    assert outcome.failed is False


def test_index_repo_all_fetch_failures_marks_failed() -> None:
    fetcher = FakeFetcher(
        {"src/a.py": "x = 1\n", "src/b.py": "y = 2\n"}, fail_paths={"src/a.py", "src/b.py"}
    )
    indexer = _index()
    outcome = fetch_and_index_repo(
        fetcher,
        indexer,
        session_id="sess-af",
        installation_id=1,
        repo="octo/demo",
        branch="main",
        commit_sha="sha1",
        max_files=100,
        max_total_bytes=1_000_000,
        max_file_bytes=1_000_000,
    )
    assert outcome.indexed_files == 0
    assert outcome.failed is True
