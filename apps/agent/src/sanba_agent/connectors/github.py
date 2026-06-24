"""Read-only GitHub context + requirement write-back (issue #7).

The pure mapping functions (issues_to_passages / requirements_to_issue_body) are
unit-tested without any network. GitHubConnector performs the actual REST calls
and is exercised only when the connector is explicitly enabled.
"""

from __future__ import annotations

import structlog
from sanba_shared.models import Priority, Requirement

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


def requirements_to_issue_body(requirements: list[Requirement], session_id: str) -> tuple[str, str]:
    """Render confirmed requirements into a GitHub issue (title, body)."""
    title = f"要件定義: {session_id}"
    if not requirements:
        return title, "（確定した要件はありません）"

    order = [Priority.MUST, Priority.SHOULD, Priority.COULD, Priority.WONT]
    labels = {
        Priority.MUST: "Must",
        Priority.SHOULD: "Should",
        Priority.COULD: "Could",
        Priority.WONT: "Won't",
    }
    lines = [
        f"SANBA の音声インタビューで確定した要件です（session `{session_id}`）。",
        "",
    ]
    for pr in order:
        group = [r for r in requirements if r.priority == pr]
        if not group:
            continue
        lines.append(f"## {labels[pr]}")
        for r in group:
            src = f" _(出所: {r.source_speaker})_" if r.source_speaker else ""
            lines.append(f"- [{r.category.value}] {r.statement}{src}")
        lines.append("")
    return title, "\n".join(lines).strip()


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

    def create_issue(self, title: str, body: str) -> str | None:  # pragma: no cover - network
        """Create an issue and return its html_url (or None on failure)."""
        import httpx

        with httpx.Client(timeout=15) as client:
            res = client.post(
                f"{_API}/repos/{self.repo}/issues",
                headers=self._headers,
                json={"title": title, "body": body},
            )
        if res.status_code in (200, 201):
            url = res.json().get("html_url")
            log.info("github_issue_created", repo=self.repo, url=url)
            return url
        log.warning("github_issue_failed", repo=self.repo, status=res.status_code)
        return None
