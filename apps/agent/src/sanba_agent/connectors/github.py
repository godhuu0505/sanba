"""Read-only GitHub context + requirement write-back.

The pure mapping function (issues_to_passages) is unit-tested without any
network. GitHubConnector performs the actual REST calls and is exercised only
when the connector is explicitly enabled.

Issue 本文の整形はここに持たない: 開発者向け出力フォーマット + 共有レンダラ
（sanba_shared.result_document）に一本化した（ADR-0043 決定3。api の /export と
同じ体裁で起票する）。
"""

from __future__ import annotations

import structlog

log = structlog.get_logger(__name__)

_API = "https://api.github.com"


def issues_to_passages(issues: list[dict], repo: str) -> list[tuple[str, str]]:
    """Map GitHub issues to (text, source) grounding passages.

    Pull requests (which the issues endpoint also returns) are skipped.
    """
    passages: list[tuple[str, str]] = []
    for issue in issues:
        if "pull_request" in issue:
            continue
        title = (issue.get("title") or "").strip()
        body = (issue.get("body") or "").strip()
        number = issue.get("number")
        if not title:
            continue
        text = f"[Issue #{number}] {title}\n{body}".strip()
        passages.append((text, f"github:{repo}#{number}"))
    return passages


class GitHubConnector:
    """Thin GitHub REST client. Only used when the connector is enabled."""

    def __init__(self, token: str, repo: str) -> None:
        # repo is "owner/name"
        self.token = token
        self.repo = repo

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def fetch_context_passages(  # pragma: no cover - network
        self, max_issues: int = 20
    ) -> list[tuple[str, str]]:
        """Fetch recent issues (and the README) as grounding passages."""
        import httpx

        passages: list[tuple[str, str]] = []
        with httpx.Client(timeout=15) as client:
            issues = client.get(
                f"{_API}/repos/{self.repo}/issues",
                headers=self._headers,
                params={"state": "all", "per_page": max_issues},
            )
            if issues.status_code == 200:
                passages.extend(issues_to_passages(issues.json(), self.repo))

            readme = client.get(
                f"{_API}/repos/{self.repo}/readme",
                headers={**self._headers, "Accept": "application/vnd.github.raw+json"},
            )
            if readme.status_code == 200 and readme.text:
                passages.append((readme.text[:4000], f"github:{self.repo}#readme"))
        log.info("github_context_fetched", repo=self.repo, passages=len(passages))
        return passages

    def create_issue(
        self, title: str, body: str, labels: list[str] | None = None
    ) -> str | None:  # pragma: no cover - network
        """Create an issue and return its html_url (or None on failure).

        labels を渡すと Issue に付与する（リポジトリに無いラベルは GitHub が自動作成する）。
        """
        import httpx

        payload: dict[str, object] = {"title": title, "body": body}
        if labels:
            payload["labels"] = labels
        with httpx.Client(timeout=15) as client:
            res = client.post(
                f"{_API}/repos/{self.repo}/issues",
                headers=self._headers,
                json=payload,
            )
        if res.status_code in (200, 201):
            url = res.json().get("html_url")
            log.info("github_issue_created", repo=self.repo, url=url, labels=labels or [])
            return url
        log.warning("github_issue_failed", repo=self.repo, status=res.status_code)
        return None
