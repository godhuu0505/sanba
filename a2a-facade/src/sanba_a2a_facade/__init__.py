"""汎用 A2A ファサード: A2A 非対応の OSS エージェントに A2A サーバの顔を与える（ADR-0069）。

初弾バックエンドは HolmesGPT。エージェント runtime は自作せず、プロトコル変換だけを担う
（ADR-0063「薄いエージェント禁止・車輪の再発明回避」の踏襲）。バックエンドが将来ネイティブ
A2A 対応した場合、SANBA 側は contract の向き先変更だけでこのファサードを退役できる。
"""

from __future__ import annotations

from .app import build_backend, create_app
from .backends import AgentBackend, HolmesBackend

__all__ = ["create_app", "build_backend", "AgentBackend", "HolmesBackend"]
