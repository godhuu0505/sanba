"""開発者向け CLI: HolmesGPT へ A2A 越しに調査を委譲する（ADR-0069）。

`uv run python -m sanba_external_agents.holmesgpt.ask "質問"` で使う。flag OFF・未設定なら
no-op 縮退の理由を表示して終了コード 1 を返す（CI・デモを壊さない fail-soft の可視化）。
"""

from __future__ import annotations

import argparse
import sys

from .client import HolmesAgentClient


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m sanba_external_agents.holmesgpt.ask",
        description="HolmesGPT (A2A facade) に調査を委譲する開発者向け CLI",
    )
    parser.add_argument("question", help="調査してほしい内容（日本語可）")
    args = parser.parse_args(argv)

    result = HolmesAgentClient().ask(args.question)
    if not result.delegated:
        print(f"delegation skipped: {result.error}", file=sys.stderr)
        return 1
    print(result.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
