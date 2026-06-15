"""External source connectors (issue #7).

Feature-flagged and OFF by default so they never affect the demo-critical path.
Currently: read-only GitHub context + requirement->issue write-back.
"""

from .github import (
    GitHubConnector,
    issues_to_passages,
    requirements_to_issue_body,
)

__all__ = ["GitHubConnector", "issues_to_passages", "requirements_to_issue_body"]
