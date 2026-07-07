"""Requirement → GitHub Issue write-back for POST /export.

契約 §4 の `POST /export` は確定要件を GitHub Issue として起票し `issue_url` と
確定要件数一致の `count` を返す。本文整形は api / agent 共通の
`sanba_shared.result_document`（開発者向け出力フォーマット）に一本化し、ここでは
GitHub API 呼び出しのみを担う。ラベルは同モジュールの
`requirements_to_issue_labels` が確定要件の priority / category から算出する。
"""

from __future__ import annotations

import structlog

log = structlog.get_logger(__name__)

_API = "https://api.github.com"


def list_repos(  # pragma: no cover - network
    token: str, per_page: int = 100, max_pages: int = 10
) -> list[str]:
    """Return repo full names ("owner/name") the token can read, newest activity first.

    02 準備「連携リポジトリ」の候補一覧。最大 max_pages * per_page 件
    （既定 1000 件）まで全ページ取得する。**途中ページの失敗は部分結果を返さず空リスト**
    にする（部分一覧を成功扱いにすると UI が Select のみを出し、載らなかった
    正当なリポジトリを選べなくなる。空なら UI は手入力へフォールバックし開始を止めない）。
    """
    import httpx

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    result: list[str] = []
    try:
        with httpx.Client(timeout=15) as client:
            for page in range(1, max_pages + 1):
                res = client.get(
                    f"{_API}/user/repos",
                    headers=headers,
                    params={"per_page": per_page, "sort": "updated", "page": page},
                )
                if res.status_code != 200:
                    # レート制限・一時障害。部分結果を候補として返さない（完全 or 手入力）。
                    log.warning("github_list_repos_failed", status=res.status_code, page=page)
                    return []
                body = res.json()
                if not isinstance(body, list) or len(body) == 0:
                    break
                result.extend(
                    r["full_name"]
                    for r in body
                    if isinstance(r, dict) and isinstance(r.get("full_name"), str)
                )
                if len(body) < per_page:
                    break  # 最終ページ
    except Exception as exc:
        log.warning("github_list_repos_failed", error=str(exc))
        return []
    return result


def create_issue(
    token: str, repo: str, title: str, body: str, labels: list[str] | None = None
) -> str | None:  # pragma: no cover - network
    """Create an issue and return its html_url (or None on failure).

    labels を渡すと Issue に付与する（リポジトリに無いラベルは GitHub が自動作成する）。
    """
    import httpx

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload: dict[str, object] = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    with httpx.Client(timeout=15) as client:
        res = client.post(
            f"{_API}/repos/{repo}/issues",
            headers=headers,
            json=payload,
        )
    if res.status_code in (200, 201):
        url = res.json().get("html_url")
        log.info("github_issue_created", repo=repo, url=url, labels=labels or [])
        return url
    log.warning("github_issue_failed", repo=repo, status=res.status_code)
    return None
