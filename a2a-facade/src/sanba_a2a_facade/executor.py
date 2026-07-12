"""a2a-sdk 用 AgentExecutor: 同期バックエンド（HolmesGPT 等）を A2A Task に橋渡す（ADR-0069）。

DefaultRequestHandler から `execute()` が呼ばれる。バックエンドの `ask()` は同期 I/O
（HolmesGPT の `/api/chat` は数十秒）なので `asyncio.to_thread` でイベントループ外に逃がす。
結果は Task の artifact として返し、`complete()` で終端する。委譲の事実は監査ストアへ
RUNNING → DONE/ERROR の順で冪等 upsert する（doc id は task_id）。監査書き込み失敗は fail-soft。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import structlog
from a2a.helpers.proto_helpers import new_task_from_user_message, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater

from .audit import DONE, ERROR, RUNNING, AuditStore, NoopAuditStore, build_record
from .backends.base import AgentBackend
from .pii import mask_pii

log = structlog.get_logger(__name__)


def _now() -> str:
    return datetime.now(UTC).isoformat()


class HolmesAgentExecutor(AgentExecutor):
    def __init__(
        self,
        backend: AgentBackend,
        *,
        timeout_seconds: float = 300.0,
        audit: AuditStore | None = None,
        retention_days: int = 30,
        clock: Callable[[], str] = _now,
    ) -> None:
        self._backend = backend
        self._timeout = timeout_seconds
        self._audit = audit or NoopAuditStore()
        self._retention_days = retention_days
        self._clock = clock

    def _expire_at(self) -> datetime:
        return datetime.now(UTC) + timedelta(days=self._retention_days)

    def _safe_upsert(self, doc_id: str, record: dict) -> None:
        try:
            self._audit.upsert(doc_id, record)
        except Exception as exc:  # noqa: BLE001
            log.warning("a2a_audit_upsert_failed", request_id=doc_id, error=str(exc))

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if context.message is None:
            raise ValueError("request has no message to investigate")
        task = context.current_task
        if task is None:
            task = new_task_from_user_message(context.message)
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)
        question = context.get_user_input()
        caller = str(context.metadata.get("caller", ""))
        masked_question = mask_pii(question)
        doc_id = task.id
        started = self._clock()
        await updater.start_work()
        await asyncio.to_thread(
            self._safe_upsert,
            doc_id,
            build_record(
                doc_id,
                masked_question,
                status=RUNNING,
                caller=caller,
                started_at=started,
                expire_at=self._expire_at(),
            ),
        )
        try:
            answer = await asyncio.to_thread(self._backend.ask, question, timeout=self._timeout)
        except Exception as exc:  # noqa: BLE001
            log.warning("a2a_backend_ask_failed", error=str(exc))
            await asyncio.to_thread(
                self._safe_upsert,
                doc_id,
                build_record(
                    doc_id,
                    masked_question,
                    status=ERROR,
                    caller=caller,
                    error=str(exc),
                    started_at=started,
                    finished_at=self._clock(),
                    expire_at=self._expire_at(),
                ),
            )
            await updater.failed(
                message=updater.new_agent_message([new_text_part("backend investigation failed")])
            )
            return
        await updater.add_artifact([new_text_part(answer)], name="investigation")
        await asyncio.to_thread(
            self._safe_upsert,
            doc_id,
            build_record(
                doc_id,
                masked_question,
                status=DONE,
                caller=caller,
                result=mask_pii(answer),
                started_at=started,
                finished_at=self._clock(),
                expire_at=self._expire_at(),
            ),
        )
        await updater.complete()
        log.info("a2a_message_send_completed", chars=len(answer))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError("cancellation is not supported by this facade")
