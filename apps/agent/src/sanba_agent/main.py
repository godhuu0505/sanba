"""LiveKit Agents worker entrypoint.

The voice agent joins a LiveKit room and runs a speech-to-speech interview with
Gemini Live. During the conversation it calls the ADK agent team (as a tool) to
plan the next question and to persist confirmed requirements.

Run locally:
    python -m sanba_agent.main dev
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, NamedTuple
from urllib.parse import urlparse

import structlog
from google.genai import types as genai_types
from livekit.agents import (
    NOT_GIVEN,
    Agent,
    AgentSession,
    CloseEvent,
    CloseReason,
    ErrorEvent,
    JobContext,
    NotGiven,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.plugins import google

try:  # noqa: SIM105
    from livekit.plugins import noise_cancellation as _noise_cancellation
except Exception:  # pragma: no cover
    _noise_cancellation = None  # type: ignore[assignment]
from sanba_shared.models import (
    AnalysisResult,
    GitHubIndexStatus,
    InviteScope,
    Priority,
    Product,
    Requirement,
    RequirementCategory,
    SessionMeta,
    Utterance,
    check_items_for_scope,
)
from sanba_shared.repository import SessionRepository

from .background import DEFAULT_MIN_NEW_UTTERANCES, AnalysisScheduler
from .config import settings
from .events import (
    DETECTOR_AMBIGUITY,
    DETECTOR_NFR,
    EVENTS_TOPIC,
    RESOLUTION_AGENT_RESOLVED,
    RESOLUTION_USER_SELECTED,
    WEB_EVENTS_TOPIC,
    EventPublisher,
    EventPublishError,
    LiveKitTransport,
    decode_analysis_visual,
    decode_user_answered,
    decode_user_selection,
    decode_user_text,
)
from .observability import get_tracer, setup_observability
from .prefetch import REASON_ACL_RECHECK, REASON_EMPTY, PrefetchCache
from .prompts.interview import (
    DEVELOPER_OPENING_INSTRUCTIONS,
    DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS,
    END_USER_OPENING_INSTRUCTIONS,
    END_USER_VOICE_AGENT_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
    build_check_items_seed,
    build_glossary_seed,
    build_language_directive,
    build_prep_analysis_note,
    build_prep_premise,
    build_repo_premise,
)
from .retrieval import GroundingStore, Passage
from .tools.analysis import analyze_transcript, heuristic_result, make_requirement_id

log = structlog.get_logger(__name__)

if settings.firestore_emulator_host:
    os.environ.setdefault("FIRESTORE_EMULATOR_HOST", settings.firestore_emulator_host)


def _repo_premise(meta: SessionMeta | None) -> str:
    """読み込み済み SessionMeta から紐づけ repo の前提一節を返す（無ければ空文字 / ADR-0028）。

    索引状態が ready/partial/indexing のときだけ前提化する（none/failed は付けない）。
    セッション文書は呼び出し側（build_agent_instructions）が 1 回だけ読む: モード判定と
    repo 前提で別々に読むと、片方だけ失敗したときに「モード不明のまま repo 前提だけ載る」
    という食い違いが起き得るため（/security-review 指摘）。
    """
    if meta is None or not meta.github_repo:
        return ""
    status = meta.github_index_status
    if status in (GitHubIndexStatus.NONE, GitHubIndexStatus.FAILED):
        return ""
    ready = status in (GitHubIndexStatus.READY, GitHubIndexStatus.PARTIAL)
    return build_repo_premise(meta.github_repo, meta.github_branch, ready, meta.github_summary)


def _session_product(repo: SessionRepository, meta: SessionMeta | None) -> Product | None:
    """セッションが従属する product を読む（プロンプトシード用 / ADR-0032 決定7）。

    glossary（end_user）と確認項目（両モード）のシードが同じ product を見るため、
    ここで 1 回だけ読む。product_id なし（単発セッション）・product 削除済み・
    Firestore 不通では None = シードなしで会話は成立させる（シードは付加価値）。
    """
    if meta is None or not meta.product_id:
        return None
    try:
        product = repo.get_product(meta.product_id)
    except Exception as exc:  # pragma: no cover
        log.warning("product_seed_read_failed", session=meta.id, error=str(exc))
        return None
    if product is None:
        log.warning("product_seed_missing", session=meta.id)
    return product


class ContextSignal(NamedTuple):
    """会話開始時に会話履歴へ出す前提読み込みバブル 1 件（``context.progress`` の元 / P1-a）。"""

    source: str
    stage: str
    label: str
    detail: str


class AgentSetup(NamedTuple):
    """build_agent_instructions の結果（初期 instructions と付随フラグの束）。"""

    instructions: str
    mode: InviteScope
    allow_repo_grounding: bool
    prep_note: str
    context_signals: tuple[ContextSignal, ...] = ()
    product_id: str | None = None


def _context_signals(
    meta: SessionMeta | None, mode: InviteScope, confirmed: bool
) -> tuple[ContextSignal, ...]:
    """会話開始時に「読み込み済み/索引中」を会話履歴へ出すためのシグナルを組み立てる（P1-a）。

    実体に正直な段階のみ（ADR-0023 §1）: prep は同期シードなので done、repo は索引状態を
    そのまま写す（ready/partial=reused, indexing/pending=running, failed=failed, none=出さない）。
    repo は end_user モードでは出さない（private repo 情報を利用者会話に出さない多層防御・
    build_agent_instructions の allow_repo_grounding と揃える）。
    """
    signals: list[ContextSignal] = []
    if meta is not None and (meta.goal or meta.goal_detail):
        detail = "ゴールとゴール詳細を確認" if meta.goal_detail else "ゴールを確認"
        signals.append(ContextSignal("prep", "done", "ゴールとゴール詳細", detail))
    if confirmed and mode is not InviteScope.DEVELOPER:
        return tuple(signals)
    if meta is not None and meta.github_repo and confirmed:
        branch = meta.github_branch or "default"
        label = f"{meta.github_repo}@{branch}"
        status = meta.github_index_status
        if status in (GitHubIndexStatus.READY, GitHubIndexStatus.PARTIAL):
            signals.append(ContextSignal("repo", "reused", label, "索引済みを利用"))
        elif status in (GitHubIndexStatus.INDEXING, GitHubIndexStatus.PENDING):
            signals.append(ContextSignal("repo", "running", label, "ソースコードを読み込み中"))
        elif status is GitHubIndexStatus.FAILED:
            signals.append(ContextSignal("repo", "failed", label, "索引に失敗しました"))
    return tuple(signals)


def build_agent_instructions(repo: SessionRepository, session_id: str) -> AgentSetup:
    """モードに応じて voice agent の初期 instructions を組み立てる（ADR-0032 決定6・7）。

    developer: 従来どおり grill-me ペルソナ + repo 前提（ADR-0028）。
    end_user: 利用者向けペルソナ + glossary シード。repo 前提は**シードしない**:
    grounding の出力遮断（決定8 / search_grounding の allowlist）に加えて、
    private repo 由来の情報が利用者の会話に露出する面を初期 instructions にも
    作らない（#321 / 多層防御として PR8 以降も維持）。

    developer では準備フォームのゴール・詳細（ADR-0035）も前提としてシードし、
    analyze 用の事前情報ノート（prep_note）を併せて返す。repo 由来のシード可否は
    「セッション文書を正しく読めて、かつ end_user でない」ときだけ True にする。
    文書が読めない（Firestore 不通・enum 版ずれ等）ときは developer ペルソナに
    落としつつ repo 前提・GitHub seed は**付けない**: モードを確認できないまま
    repo 由来を載せると end_user セッションへ private 情報が漏れ得るため、
    フェイルオープンにしない（/security-review 指摘・`_repo_access` と同じ倒し方）。
    セッション文書はここで 1 回だけ読み、判定の食い違いを作らない。
    """
    meta: SessionMeta | None = None
    confirmed = False
    try:
        meta = repo.get_session(session_id)
        confirmed = True
    except Exception as exc:  # pragma: no cover
        log.warning("session_meta_read_failed", session=session_id, error=str(exc))
    mode = meta.interview_mode if meta is not None else InviteScope.DEVELOPER
    prep_note = ""
    product = _session_product(repo, meta)
    seeded_check_items = (
        check_items_for_scope(product.check_items, mode) if product is not None else []
    )
    check_items_seed = build_check_items_seed(
        seeded_check_items, end_user=mode is InviteScope.END_USER
    )
    if mode is InviteScope.END_USER:
        assert meta is not None
        glossary_seed = (
            build_glossary_seed(product.name, product.glossary) if product is not None else ""
        )
        instructions = END_USER_VOICE_AGENT_INSTRUCTIONS + glossary_seed + check_items_seed
        allow_repo_grounding = False
    else:
        prep_premise = ""
        if meta is not None:
            prep_premise = build_prep_premise(meta.goal, meta.goal_detail, meta.roles)
            prep_note = build_prep_analysis_note(meta.goal, meta.goal_detail)
        instructions = (
            VOICE_AGENT_INSTRUCTIONS
            + prep_premise
            + (_repo_premise(meta) if confirmed else "")
            + check_items_seed
        )
        allow_repo_grounding = confirmed and meta is not None
    instructions += build_language_directive(settings.gemini_language)
    signals = _context_signals(meta, mode, confirmed)
    log.info(
        "agent_instructions_built",
        session=session_id,
        interview_mode=mode.value,
        mode_confirmed=confirmed,
        allow_repo_grounding=allow_repo_grounding,
        has_prep_context=bool(prep_note),
        check_items_count=len(seeded_check_items),
        context_signals=len(signals),
        chars=len(instructions),
    )
    product_id = meta.product_id if meta is not None else None
    return AgentSetup(instructions, mode, allow_repo_grounding, prep_note, signals, product_id)


def opening_instructions(mode: InviteScope, has_prep_context: bool = False) -> str:
    """接続直後の最初の一問の指示（モード別）。

    developer で準備情報がシード済みなら、ゼロからの聞き取りではなく準備情報の
    認識合わせ→深掘りから始めさせる（ADR-0035）。
    """
    if mode is InviteScope.END_USER:
        return END_USER_OPENING_INSTRUCTIONS
    if has_prep_context:
        return DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS
    return DEVELOPER_OPENING_INSTRUCTIONS


def _is_stale_repo_passage(source: str, current_sha: str) -> bool:
    """repo 索引 chunk のうち現在の commit sha 以外を stale と判定する（ADR-0028）。

    repo 索引の source は `github:{repo}@{branch}@{sha}:{path}` で sha を内包する。旧
    env connector の source（`github:{repo}#...`）は `@` を含まないため対象外（False）。
    """
    if not source.startswith("github:") or "@" not in source:
        return False
    return f"@{current_sha}:" not in source


_USER_DERIVED_KINDS = frozenset({"utterance", "requirement"})

PREFETCH_TIMEOUT_SECONDS = 5.0
ANALYSIS_TIMEOUT_SECONDS = settings.analysis_timeout_seconds
DRAIN_GRACE_SECONDS = 2.0
ACL_RECHECK_TIMEOUT_SECONDS = 2.0


async def _drain_tasks(tasks: set[asyncio.Task[Any]], grace_seconds: float) -> tuple[int, int]:
    """走行中タスクを猶予付きで待ち、残りをキャンセルする。(完了数, キャンセル数) を返す。

    セッション終了時のドレン用（ADR-0037）。publish の取りこぼしを減らしつつ、
    シャットダウンを長くブロックしない。
    """
    live = {t for t in tasks if not t.done()}
    if not live:
        return 0, 0
    done, pending = await asyncio.wait(live, timeout=grace_seconds)
    for t in pending:
        t.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    return len(done), len(pending)


def _partition_passages_for_output(
    passages: list[Passage],
) -> tuple[list[Passage], int, int]:
    """出力制御の allowlist で passage を分け、(返す, repo由来の遮断数, その他の遮断数) を返す。

    repo 由来の判別は kind（allowlist 外）に加えて source の `github:` 接頭辞でも数える
    （観測性と background シグナル用の分類。遮断そのものは kind の allowlist が決めるので、
    source の表記揺れで遮断がすり抜けることはない）。
    """
    kept: list[Passage] = []
    dropped_repo = 0
    dropped_other = 0
    for p in passages:
        if p.kind in _USER_DERIVED_KINDS:
            kept.append(p)
        elif p.source.strip().lower().startswith("github:"):
            dropped_repo += 1
        else:
            dropped_other += 1
    return kept, dropped_repo, dropped_other


class SANBAAgent(Agent):
    """The voice interviewer. Owns the tools that bridge to the ADK team."""

    def __init__(
        self,
        session_id: str,
        repo: SessionRepository,
        grounding: GroundingStore,
        publisher: EventPublisher | None = None,
    ) -> None:
        setup = build_agent_instructions(repo, session_id)
        super().__init__(instructions=setup.instructions)
        self._interview_mode = setup.mode
        self._allow_repo_grounding = setup.allow_repo_grounding
        self._prep_note = setup.prep_note
        self._context_signals = setup.context_signals
        self._session_id = session_id
        self._product_id = setup.product_id
        self._repo = repo
        self._grounding = grounding
        self._transcript: list[str] = []
        self._publisher = publisher
        self._utterance_seq = 0
        self._pending_user_uid: str | None = None
        self._agent_utterance_seq = 0
        self._question_seq = 0
        self._questions: dict[str, str] = {}
        self._current_question_id: str | None = None
        self._question_asked_turn = -1
        self._published_gaps: set[str] = set()
        self._published_ambiguous: set[str] = set()
        self._injected_assets: set[str] = set()
        self._publish_tasks: set[asyncio.Task[Any]] = set()
        self._persist_tasks: set[asyncio.Task[Any]] = set()
        self._persist_lock = asyncio.Lock()
        self._prefetch = PrefetchCache()
        self._prefetch_task: asyncio.Task[None] | None = None
        self._user_turn = 0
        self._analysis_scheduler = AnalysisScheduler()
        self._analysis_task: asyncio.Task[None] | None = None
        self._analysis_lock = asyncio.Lock()
        self._last_analysis: AnalysisResult | None = None
        self._analysis_covered_turn = -1
        self._shutdown_hook: Callable[[str], None] | None = None
        self._end_proposed = False
        self._completed = False

    @property
    def transcript(self) -> list[str]:
        return self._transcript

    @property
    def interview_mode(self) -> InviteScope:
        """このセッションのインタビュー・モード（ADR-0032 決定6。entrypoint が参照）。"""
        return self._interview_mode

    @property
    def has_prep_context(self) -> bool:
        """準備フォームの事前情報がシード済みか（ADR-0035。開始指示の分岐に使う）。"""
        return bool(self._prep_note)

    @property
    def allow_repo_grounding(self) -> bool:
        """repo 由来素材（GitHub seed）を許すか。モード確認済みの非 end_user のみ True。"""
        return self._allow_repo_grounding

    @property
    def session_id(self) -> str:
        return self._session_id

    def claim_video_injection(self, asset_id: str) -> bool:
        """動画解析の会話注入を 1 回だけ許可する（ADR-0040 §4）。

        - end_user モードでは注入しない（grounding 出力制御 ADR-0032 決定8 と揃え、
          内部素材の観察が Live 発話へ素通りするのを防ぐ）。allow_repo_grounding を流用する。
        - 同一 asset は 1 回だけ（`_published_gaps` と同じ dedup パターン）。
        許可したら asset_id を消費して True。以後の同一 asset は False。
        """
        if not self._allow_repo_grounding:
            return False
        if asset_id in self._injected_assets:
            return False
        self._injected_assets.add(asset_id)
        return True

    async def emit_context_progress(self) -> None:
        """会話開始時に前提読み込み（prep/repo）の状態を会話履歴へ 1 回だけ流す（P1-a）。

        build_agent_instructions が読んだ meta から算出したシグナルを ``context.progress``
        として publish する。音声は止めない・フェイク進捗は出さない（ADR-0023 §1）。
        publish は seq を消費するので、送信後に session_seq を保存して再起動後の単調性を保つ。
        """
        if self._publisher is None or not self._context_signals:
            return
        for sig in self._context_signals:
            with contextlib.suppress(Exception):
                await self._publisher.context_progress(
                    sig.source, sig.stage, label=sig.label, detail=sig.detail
                )
        self._repo.set_session_seq(self._session_id, self._publisher.seq)

    def set_shutdown_hook(self, hook: Callable[[str], None]) -> None:
        """セッションを終える手段（ctx.shutdown）を注入する（P1-b）。

        complete_session ツールがユーザー同意後にこれを遅延起動し、締めの一言を
        読み上げ終える猶予をおいてルームから退出する。
        """
        self._shutdown_hook = hook

    def _open_detection_count(self) -> int:
        """未解消の検知（gap/ambiguous）件数。終了提案・確定の可否判定に使う（P1-b）。

        agent が publish し resolve で外す open 集合そのもの（web の「未解消 N」と一致）。
        サーバ側 finalize も list_open_detections で二重にゲートするので、ここは good-faith。
        """
        return len(self._published_gaps) + len(self._published_ambiguous)

    @property
    def current_question_id(self) -> str | None:
        """現在の未回答質問 id（#212 §5-6。発話受信時点で束ねるために読む）。"""
        return self._current_question_id

    def _publish(self, coro) -> None:  # type: ignore[no-untyped-def]
        """同期コンテキストから publish をスケジュールする（seq は publisher 側で直列化）。"""
        if self._publisher is None:
            coro.close()
            return
        task = asyncio.create_task(coro)
        self._publish_tasks.add(task)
        task.add_done_callback(self._on_publish_done)

    def _on_publish_done(self, task: asyncio.Task[Any]) -> None:
        self._publish_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.warning("publish_task_failed", error=str(task.exception()))

    def _persist(self, fn: Callable[[], None]) -> None:
        """ブロッキングな永続化（Firestore・grounding 索引）をイベントループ外へ逃がす。

        実行中のイベントループが無い環境（同期ユニットテスト）ではその場で実行し、従来どおり
        即時に永続化する。ループがあるとき（音声 worker）はスレッドへ逃がして音声パイプライン
        のループを塞がない。順序は _persist_lock で発話の到着順に直列化する（保存順の逆転防止）。
        失敗は fail-soft: ログに残すが会話は止めない（分析入力の transcript は同期で保持済み）。
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            fn()
            return

        async def _run() -> None:
            async with self._persist_lock:
                await asyncio.to_thread(fn)

        task = loop.create_task(_run())
        self._persist_tasks.add(task)
        task.add_done_callback(self._on_persist_done)

    def _on_persist_done(self, task: asyncio.Task[Any]) -> None:
        self._persist_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.warning(
                "persist_task_failed", session=self._session_id, error=str(task.exception())
            )

    def record_utterance(self, speaker: str, text: str, *, utterance_id: str | None = None) -> str:
        if utterance_id is None:
            self._utterance_seq += 1
            utterance_id = f"u{self._utterance_seq}"
        self._transcript.append(f"[{utterance_id}] {speaker}: {text}")
        session_id = self._session_id
        repo = self._repo
        grounding = self._grounding

        def _write() -> None:
            repo.add_utterance(session_id, Utterance(speaker=speaker, text=text))
            grounding.index_passage(
                text=text,
                source=f"{session_id}:{speaker}",
                kind="utterance",
                session_id=session_id,
            )

        self._persist(_write)
        if self._publisher is not None:
            role = "participant"
            self._publish(self._publisher.transcript_final(speaker, role, utterance_id, text))
        if speaker == "participant":
            self._user_turn += 1
            self._start_prefetch(text)
            if self._analysis_scheduler.note_utterance():
                self._start_background_analysis()
        return utterance_id

    def publish_user_partial(self, text: str) -> None:
        """ユーザー音声の認識中（partial）テキストを web の会話履歴へ流す（#248 拡張）。

        final まで安定した utterance_id を使い回すことで、web は同じ吹き出しを更新し続け、
        確定前は「文字起こし中」を示せる（partial→final の差し替え）。publisher 未設定なら no-op。
        """
        if self._publisher is None:
            return
        if self._pending_user_uid is None:
            self._utterance_seq += 1
            self._pending_user_uid = f"u{self._utterance_seq}"
        self._publish(
            self._publisher.transcript_partial(
                "participant", "participant", self._pending_user_uid, text
            )
        )

    def record_user_final(self, text: str) -> str:
        """確定したユーザー音声を記録する（会話履歴・分析・grounding）。

        認識中に割り当てた utterance_id があればそれで確定し、web 側で partial の吹き出しを
        そのまま final に差し替える。無ければ record_utterance が新規採番する。
        """
        uid = self._pending_user_uid
        self._pending_user_uid = None
        return self.record_utterance("participant", text, utterance_id=uid)

    def publish_agent_utterance(self, text: str) -> None:
        """SANBA（エージェント）の発話を web の会話履歴へ出す（role=assistant で左吹き出し）。

        音声だけでは聞き逃す発話もテキストで追えるようにする。分析用 transcript には
        載せない（LLM 応答は要件抽出の入力ではないため）。participant の u{n} と衝突しない
        a{n} 空間で採番する。publisher 未設定なら no-op。
        """
        if self._publisher is None:
            return
        self._agent_utterance_seq += 1
        uid = f"a{self._agent_utterance_seq}"
        self._publish(self._publisher.transcript_final("SANBA", "assistant", uid, text))

    def record_answer(self, question_id: str, answer: str) -> str | None:
        """通常質問（#181）への回答を、問い本文とともに発話として記録する（Codex P2）。

        question_id から問い本文を引けるなら「問「…」への回答：…」の形で記録し、後続の
        analyze_requirements が何についての回答か分かる（要件化・引用の欠落を防ぐ）。
        引けない場合は回答のみ記録する。生成応答の文脈に使えるよう問い本文を返す。
        """
        prompt = self._questions.get(question_id)
        text = f"問「{prompt}」への回答：{answer}" if prompt else answer
        self.record_utterance("participant", text)
        return prompt

    async def resolve_detection(self, detection_id: str, selected_value: str) -> None:
        """ユーザーの選択（user.selection, 契約 §4.5）を受けて検知を解消する（#102）。

        web の検知カードで選択肢がタップされると呼ばれ、当該検知を解消済みにして
        detection.resolved を web へ返す（カードが閉じ、リロードでも未解消に戻らない）。
        選択内容は以後の会話の前提として記録しておく。
        """
        self._transcript.append(f"[選択] {detection_id} → {selected_value}")
        self._repo.resolve_detection(self._session_id, detection_id, RESOLUTION_USER_SELECTED)
        self._published_gaps.discard(detection_id)
        self._published_ambiguous.discard(detection_id)
        if self._publisher is not None:
            await self._publisher.detection_resolved(
                detection_id,
                resolution=RESOLUTION_USER_SELECTED,
                selected_value=selected_value,
            )
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        log.info(
            "detection_resolved",
            session=self._session_id,
            detection=detection_id,
            value=selected_value,
        )

    @function_tool
    async def analyze_requirements(self, _ctx: RunContext) -> dict:
        """これまでの会話から確定要件を点検し、次に聞くべき1問を返す。

        会話が一区切りついたとき、または論点が曖昧なときに呼び出す。
        """
        task = self._analysis_task
        if task is not None and not task.done():
            if self._publisher is not None:
                await self._publisher.status("deliberating")
            done, _pending = await asyncio.wait(
                {task}, timeout=settings.analysis_ride_along_timeout_seconds
            )
            if self._publisher is not None:
                await self._publisher.status("listening")
            if not done:
                log.info(
                    "analysis_ride_along_timeout",
                    session=self._session_id,
                    turn=self._user_turn,
                )
                last = self._last_analysis
                if last is not None:
                    return last.model_dump(mode="json")
                return heuristic_result("\n".join(self._transcript)).model_dump(mode="json")
        last = self._last_analysis
        if (
            last is not None
            and self._user_turn - self._analysis_covered_turn < DEFAULT_MIN_NEW_UTTERANCES
        ):
            log.info(
                "analysis_cache_hit",
                session=self._session_id,
                covered_turn=self._analysis_covered_turn,
                turn=self._user_turn,
            )
            return last.model_dump(mode="json")
        self._analysis_scheduler.start()
        try:
            if self._publisher is not None:
                await self._publisher.status("deliberating")
            result = await self._run_analysis(trigger="tool")
        finally:
            self._analysis_scheduler.finish()
        if self._publisher is not None:
            await self._publisher.status("listening")
        return result.model_dump(mode="json")

    async def _run_analysis(
        self, *, trigger: str, timeout_seconds: float | None = None
    ) -> AnalysisResult:
        """transcript を分析し、検知（gap/ambiguous）の publish まで行う共通経路。

        ツールの同期フォールバックと背景実行（ADR-0037 段階B）の両方が通る。timeout は
        LLM 分析部分にだけ適用し、publish は中断しない（部分 publish で _published_gaps と
        web の整合が崩れるのを避ける）。
        """
        transcript = "\n".join(self._transcript)
        if self._prep_note:
            transcript = f"{self._prep_note}\n{transcript}"
        covered_turn = self._user_turn
        tracer = get_tracer("sanba.voice")
        span_cm = (
            tracer.start_as_current_span("sanba.voice.analysis")
            if tracer is not None
            else contextlib.nullcontext()
        )
        started = time.monotonic()
        with span_cm as span:
            if span is not None:
                span.set_attribute("sanba.analysis.trigger", trigger)
            if timeout_seconds is not None:
                result = await asyncio.wait_for(self._analyze_off_loop(transcript), timeout_seconds)
            else:
                result = await self._analyze_off_loop(transcript)
        duration_ms = int((time.monotonic() - started) * 1000)
        log.info(
            "analysis",
            session=self._session_id,
            trigger=trigger,
            duration_ms=duration_ms,
            open_topics=result.open_topics,
            next_question=result.next_question,
        )
        async with self._analysis_lock:
            await self._publish_analysis_detections(result)
        self._last_analysis = result
        self._analysis_covered_turn = covered_turn
        return result

    async def _analyze_off_loop(self, transcript: str) -> AnalysisResult:
        """ADK 分析を専用スレッドの独立イベントループで実行する（ADR-0046 段階1・#375）。

        逐次 LLM 往復（interview_lead + サブエージェント）を音声 worker のイベントループから
        隔離し、分析の遅延・失敗が音声ターンのジッタ・破綻へ波及しないようにする。
        grounding 検索（to_thread 済み）と同じ規律で、分析経路だけ残っていた非対称を解消する。
        スレッドは daemon にする: タイムアウト後に走り続けても SIGTERM 時のプロセス退出を
        塞がない（結果は future 側のガードで破棄される）。
        """
        loop = asyncio.get_running_loop()
        future: asyncio.Future[AnalysisResult] = loop.create_future()

        def _worker() -> None:
            outcome: AnalysisResult | BaseException
            try:
                outcome = asyncio.run(analyze_transcript(transcript))
            except Exception as exc:  # noqa: BLE001
                outcome = exc

            def _deliver() -> None:
                if future.done():
                    return
                if isinstance(outcome, BaseException):
                    future.set_exception(outcome)
                else:
                    future.set_result(outcome)

            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(_deliver)

        threading.Thread(
            target=_worker, name=f"sanba-analysis-{self._session_id}", daemon=True
        ).start()
        return await future

    def _start_background_analysis(self) -> None:
        """debounce 判定を通った背景分析タスクを起動する（ADR-0037 段階B）。

        イベントループが無い環境（同期ユニットテスト等）では黙ってスキップする。
        背景分析は付加価値で、ツールの同期経路が常に最新化を保証する。
        """
        if self._analysis_task is not None and not self._analysis_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._analysis_scheduler.start()
        self._analysis_task = loop.create_task(self._background_analyze())

    async def _background_analyze(self) -> None:
        try:
            await self._run_analysis(trigger="background", timeout_seconds=ANALYSIS_TIMEOUT_SECONDS)
        except TimeoutError:
            log.warning("background_analysis_timeout", session=self._session_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("background_analysis_failed", session=self._session_id, error=str(exc))
        finally:
            self._analysis_task = None
            if self._analysis_scheduler.finish():
                log.info("background_analysis_followup", session=self._session_id)
                self._start_background_analysis()

    async def _publish_analysis_detections(self, result: AnalysisResult) -> None:
        """分析結果から検知（gap/ambiguous）を永続化し web へ publish する。

        呼び出し側（_run_analysis）が _analysis_lock で直列化している前提。status は
        触らない（背景実行は不可視・deliberating/listening はツール経路だけが出す）。
        """
        if self._publisher is not None:
            current = {make_requirement_id(f"gap:{t}"): t for t in result.open_topics}
            for gap_id, topic in current.items():
                if gap_id in self._published_gaps:
                    continue
                self._published_gaps.add(gap_id)
                self._end_proposed = False
                summary = f"{topic}が未確認です。"
                self._repo.save_detection(
                    self._session_id,
                    {
                        "id": gap_id,
                        "kind": "gap",
                        "summary": summary,
                        "category": "non_functional",
                        "refs": [],
                        "detector": DETECTOR_NFR,
                        "resolved": False,
                    },
                )
                await self._publisher.detection_gap(
                    gap_id,
                    summary=summary,
                    category="non_functional",
                    refs=[],
                    detector=DETECTOR_NFR,
                )
            for gap_id in list(self._published_gaps):
                if gap_id not in current:
                    self._published_gaps.discard(gap_id)
                    self._repo.resolve_detection(
                        self._session_id, gap_id, RESOLUTION_AGENT_RESOLVED
                    )
                    await self._publisher.detection_resolved(
                        gap_id, resolution=RESOLUTION_AGENT_RESOLVED
                    )
            current_ambiguous = {
                make_requirement_id(f"ambiguous:{t}"): t for t in result.ambiguous_topics
            }
            for amb_id, snippet in current_ambiguous.items():
                if amb_id in self._published_ambiguous:
                    continue
                self._published_ambiguous.add(amb_id)
                self._end_proposed = False
                summary = f"「{snippet}」は具体的な基準が不明瞭です。"
                self._repo.save_detection(
                    self._session_id,
                    {
                        "id": amb_id,
                        "kind": "ambiguous",
                        "summary": summary,
                        "refs": [],
                        "detector": DETECTOR_AMBIGUITY,
                        "resolved": False,
                    },
                )
                await self._publisher.detection_ambiguous(
                    amb_id,
                    summary=summary,
                    refs=[],
                    detector=DETECTOR_AMBIGUITY,
                )
            for amb_id in list(self._published_ambiguous):
                if amb_id not in current_ambiguous:
                    self._published_ambiguous.discard(amb_id)
                    self._repo.resolve_detection(
                        self._session_id, amb_id, RESOLUTION_AGENT_RESOLVED
                    )
                    await self._publisher.detection_resolved(
                        amb_id, resolution=RESOLUTION_AGENT_RESOLVED
                    )
            self._repo.set_session_seq(self._session_id, self._publisher.seq)

    async def drain_background_tasks(self, grace_seconds: float = DRAIN_GRACE_SECONDS) -> None:
        """セッション終了時に背景タスクを猶予付きで送り切り、残りはキャンセルする（ADR-0037）。

        対象は先読み・背景分析・fire-and-forget publish・書き込み永続化。
        評価（score_session）より前に呼ぶ。
        """
        tasks: set[asyncio.Task[Any]] = set(self._publish_tasks)
        tasks |= set(self._persist_tasks)
        if self._prefetch_task is not None:
            tasks.add(self._prefetch_task)
        if self._analysis_task is not None:
            tasks.add(self._analysis_task)
        completed, cancelled = await _drain_tasks(tasks, grace_seconds)
        if completed or cancelled:
            log.info(
                "background_tasks_drained",
                session=self._session_id,
                completed=completed,
                cancelled=cancelled,
            )

    @function_tool
    async def ask_question(
        self,
        _ctx: RunContext,
        prompt: str,
        options: list[str] | None = None,
    ) -> dict:
        """次に聞くべき問いを1つ、画面の問いピン（金枠）に提示する。

        音声で問いかけると同時に呼ぶと、参加者は選択肢をタップでも答えられる（#181）。

        Args:
            prompt: 問いの一文（例「並び順は何を既定にしますか」）。
            options: 選択肢ラベル（2〜4個。例 ["関連度順","新着順"]）。
                自由に答えてほしい問いでは省略する（音声/テキストで回答）。
        """
        superseded_in_turn = (
            self._current_question_id is not None and self._question_asked_turn == self._user_turn
        )
        if superseded_in_turn:
            superseded = self._current_question_id
            assert superseded is not None
            log.info(
                "question_superseded",
                session=self._session_id,
                previous=superseded,
                turn=self._user_turn,
            )
            await self.clear_current_question(superseded)
        self._question_seq += 1
        question_id = f"{make_requirement_id(f'q:{prompt}')}-{self._question_seq}"
        self._questions[question_id] = prompt
        opts = [{"label": o, "value": o} for o in (options or [])]
        self._current_question_id = question_id
        self._question_asked_turn = self._user_turn
        if self._publisher is not None:

            def _persist_current(asked_seq: int) -> None:
                self._repo.save_current_question(
                    self._session_id,
                    {"id": question_id, "prompt": prompt, "options": opts},
                    asked_seq,
                )

            try:
                await self._publisher.question_asked(
                    question_id, prompt, options=opts or None, on_persist=_persist_current
                )
            except Exception as exc:  # noqa: BLE001
                self._current_question_id = None
                log.warning(
                    "question_persist_failed",
                    session=self._session_id,
                    id=question_id,
                    error=str(exc),
                )
        log.info("question_asked", session=self._session_id, id=question_id, options=len(opts))
        result: dict[str, Any] = {"asked": question_id}
        if superseded_in_turn:
            result["note"] = (
                "同一ターンで複数の問いを立てました。前の問いは差し替えました。"
                "1ターンにつき問いは1つだけにし、質問を畳みかけないでください。"
            )
        return result

    async def clear_current_question(self, question_id: str) -> None:
        """回答を受けて現在質問をクリアし、``question.cleared`` を全参加者へ伝播する。

        ADR-0020 §5-3 / §5-5 / §5-7 / §5-9: 現在質問 id == ``question_id`` のとき（Firestore CAS が
        成功したとき）だけ tombstone 化 + publish する。タップ回答（``user.answered`` の id 一致）と
        自由記述/音声回答（受信時点の current id を束ねたもの）の双方から呼ばれる。古い回答や再送が
        遅れて届いても、id が一致しなければ新しい問いを消さない（CAS が守る）。
        """
        if self._publisher is None:
            return

        def _persist_tombstone(cleared_seq: int) -> bool:
            return self._repo.clear_current_question(self._session_id, question_id, cleared_seq)

        cleared = False
        try:
            env = await self._publisher.question_cleared(question_id, on_persist=_persist_tombstone)
            cleared = env is not None
        except EventPublishError as exc:
            cleared = True
            log.warning(
                "question_cleared_publish_failed",
                session=self._session_id,
                id=question_id,
                error=str(exc),
            )
        if cleared and self._current_question_id == question_id:
            self._current_question_id = None
        log.info("question_cleared", session=self._session_id, id=question_id, cleared=cleared)

    @function_tool
    async def save_requirement(
        self,
        _ctx: RunContext,
        statement: str,
        category: str = "functional",
        priority: str = "should",
        source_speaker: str | None = None,
        citations: list[str] | None = None,
    ) -> dict:
        """確定した要件を1件記録する。

        Args:
            statement: 要件の一文(例「同時に最大5人が音声で参加できること」)。
            category: functional / non_functional / constraint / scope / open_question
            priority: must / should / could / wont
            source_speaker: その要件を述べた参加者の識別子(任意)。
            citations: その要件の根拠となった発話 id のリスト(例 ["u3", "u5"])。
                会話本文の各行頭にある [u..] を参照する。要件カードの引用表示に使う。
        """
        requirement = Requirement(
            id=make_requirement_id(statement),
            statement=statement,
            category=RequirementCategory(category),
            priority=Priority(priority),
            source_speaker=source_speaker,
            citations=citations or [],
        )
        self._repo.save_requirement(self._session_id, requirement)
        self._grounding.index_passage(
            text=statement,
            source=f"requirement:{requirement.id}",
            kind="requirement",
            session_id=self._session_id,
        )
        if self._publisher is not None:
            await self._publisher.requirement_upserted(requirement, status="confirmed")
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        log.info("requirement_saved", session=self._session_id, id=requirement.id)
        return {"saved": requirement.id}

    @function_tool
    async def note_visual_requirement(
        self, _ctx: RunContext, observation: str, statement: str
    ) -> dict:
        """画面共有やモックなど視覚情報から読み取った要件を記録する。

        Args:
            observation: 画面で観察した内容(例「ログイン画面にSSOボタンがある」)。
            statement: そこから導いた要件の一文。
        """
        requirement = Requirement(
            id=make_requirement_id(statement),
            statement=statement,
            category=RequirementCategory.FUNCTIONAL,
            source_speaker="screen-share",
        )
        self._repo.save_requirement(self._session_id, requirement)
        self._grounding.index_passage(
            text=f"{statement}（画面観察: {observation}）",
            source=f"visual:{requirement.id}",
            kind="requirement",
            session_id=self._session_id,
        )
        if self._publisher is not None:
            await self._publisher.analysis_visual(
                asset_id=f"visual:{requirement.id}",
                extracted=[observation],
                conflicts=[],
            )
            await self._publisher.requirement_upserted(requirement, status="confirmed")
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        log.info("visual_requirement", session=self._session_id, id=requirement.id)
        return {"saved": requirement.id, "from": "screen-share"}

    @function_tool
    async def search_grounding(self, _ctx: RunContext, query: str) -> dict:
        """要件定義の知識ベースと過去セッションを検索し、根拠(引用元つき)を返す。

        質問の妥当性を裏付けたいとき、または「過去に似た議論がなかったか」を
        確認したいときに使う。返り値の sources を会話で言及して根拠を示すこと。
        返り値に `background`（引用できない内部資料の関連ヒット件数のみ）が付くことがある。
        その場合は内容・出所に一切触れず、話題の関連が深い合図としてだけ扱うこと。
        """
        entry, reason = self._prefetch.get(query, turn=self._user_turn)
        if entry is not None and await self._cached_repo_sources_invalid(entry.result):
            entry, reason = None, REASON_ACL_RECHECK
        if entry is not None:
            log.info(
                "prefetch_hit",
                session=self._session_id,
                query=query,
                prefetch_query=entry.query,
                latency_saved_ms=int(entry.search_seconds * 1000),
            )
            return entry.result
        if reason != REASON_EMPTY:
            log.info("prefetch_miss", session=self._session_id, reason=reason)
        return await asyncio.to_thread(self._grounded_search, query)

    def _start_prefetch(self, text: str) -> None:
        """確定発話を種に grounding 検索を先読みする（ADR-0037 段階A / latest-wins）。

        同期コンテキストから呼ばれるためイベントループが無い環境（同期ユニットテスト等）
        では黙ってスキップする。先読みは付加価値であり、失敗してもツールの同期経路が守る。
        """
        query = text.strip()
        if not query:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._prefetch_task is not None and not self._prefetch_task.done():
            self._prefetch_task.cancel()
        task = loop.create_task(self._prefetch_search(query, self._user_turn))
        self._prefetch_task = task
        task.add_done_callback(self._on_prefetch_done)

    def _on_prefetch_done(self, task: asyncio.Task[None]) -> None:
        if task is self._prefetch_task:
            self._prefetch_task = None
        if not task.cancelled() and task.exception() is not None:
            log.warning(
                "prefetch_task_failed", session=self._session_id, error=str(task.exception())
            )

    async def _prefetch_search(self, query: str, turn: int) -> None:
        started = time.monotonic()
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(self._grounded_search, query), PREFETCH_TIMEOUT_SECONDS
            )
        except TimeoutError:
            log.warning("prefetch_timeout", session=self._session_id, query=query)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("prefetch_failed", session=self._session_id, error=str(exc))
            return
        duration = time.monotonic() - started
        self._prefetch.put(query, result, turn=turn, search_seconds=duration)
        log.info(
            "prefetch_ready",
            session=self._session_id,
            turn=turn,
            hits=len(result["passages"]),
            duration_ms=int(duration * 1000),
        )

    async def _cached_repo_sources_invalid(self, result: dict[str, Any]) -> bool:
        """先読み結果に repo 由来 passage が含まれる場合、ACL（revoked/sha）を再検証する。

        Firestore 読み（同期クライアント・最大2回）は to_thread + タイムアウトで包み、
        音声パイプラインのイベントループを塞がない（sanba-reviewer P1）。判定できない
        とき（タイムアウト・障害）は安全側に True を返し、最新 ACL を適用する同期検索へ
        倒す（fail-closed）。repo 由来を含まない結果（end_user モードの allowlist 出力を
        含む）は再検証不要で False。
        """
        if not any(p["source"].startswith("github:") for p in result["passages"]):
            return False
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._repo_sources_acl_invalid, result),
                ACL_RECHECK_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            log.warning("prefetch_acl_recheck_timeout", session=self._session_id)
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("prefetch_acl_recheck_failed", session=self._session_id, error=str(exc))
            return True

    def _repo_sources_acl_invalid(self, result: dict[str, Any]) -> bool:
        current_sha, revoked = self._repo_access()
        if revoked:
            return True
        return current_sha is not None and any(
            _is_stale_repo_passage(p["source"], current_sha) for p in result["passages"]
        )

    def _grounded_search(self, query: str) -> dict[str, Any]:
        """grounding 検索を span で計測して返す（ADR-0051）。

        属性は非 PII（session/hits/filtered）のみで、クエリ本文は Cloud Trace に載せない。
        to_thread 越し（ワーカースレッド）に呼ばれるため独立スパンになる（会話ターンには入れ子で
        ぶら下がらないが、session 属性で絞り込める）。
        """
        tracer = get_tracer("sanba.voice")
        span_cm = (
            tracer.start_as_current_span("sanba.grounding.search")
            if tracer is not None
            else contextlib.nullcontext()
        )
        with span_cm as span:
            result = self._grounded_search_inner(query)
            if span is not None:
                span.set_attribute("sanba.session_id", self._session_id)
                span.set_attribute("sanba.grounding.hits", len(result["passages"]))
                span.set_attribute(
                    "sanba.grounding.output_filtered", not self._allow_repo_grounding
                )
            return result

    def _grounded_search_inner(self, query: str) -> dict[str, Any]:
        """検索と出力制御の一体経路（同期）。ツールと先読みの両方が必ずここを通る。

        ADR-0037 決定2: 先読み用の別経路を作らないことで、キャッシュには出力制御
        （ADR-0032 決定8 / ACL / stale 遮断）通過後の結果しか入らないことを構造的に保証する。
        """
        want = 4
        current_sha, revoked = self._repo_access()
        output_filtered = not self._allow_repo_grounding
        fetch_k = want * 4 if (current_sha is not None or revoked or output_filtered) else want
        passages = self._grounding.search(
            query, k=fetch_k, session_id=self._session_id, product_id=self._product_id
        )
        dropped_repo = dropped_other = 0
        if output_filtered:
            if revoked:
                passages = [p for p in passages if not p.source.startswith("github:")]
            elif current_sha is not None:
                passages = [
                    p for p in passages if not _is_stale_repo_passage(p.source, current_sha)
                ]
            _, dropped_repo, dropped_other = _partition_passages_for_output(passages)
            passages = self._grounding.search(
                query,
                k=want,
                kinds=list(_USER_DERIVED_KINDS),
                session_id=self._session_id,
            )
        else:
            if revoked:
                passages = [p for p in passages if not p.source.startswith("github:")]
            elif current_sha is not None:
                passages = [
                    p for p in passages if not _is_stale_repo_passage(p.source, current_sha)
                ]
            passages = passages[:want]
        repo_hits = sum(1 for p in passages if p.source.startswith("github:"))
        log.info(
            "grounding_search",
            session=self._session_id,
            query=query,
            hits=len(passages),
            repo_hits=repo_hits,
            interview_mode=self._interview_mode.value,
            output_filtered=output_filtered,
        )
        if dropped_repo or dropped_other:
            log.info(
                "grounding_output_filtered",
                session=self._session_id,
                interview_mode=self._interview_mode.value,
                dropped_repo=dropped_repo,
                dropped_other=dropped_other,
                returned=len(passages),
            )
        result: dict[str, Any] = {
            "passages": [
                {"text": p.text, "source": p.source, "kind": p.kind, "score": p.score}
                for p in passages
            ]
        }
        if dropped_repo:
            result["background"] = {"related_internal_hits": dropped_repo}
        return result

    def _repo_access(self) -> tuple[str | None, bool]:
        """(現在の commit sha, 連携無効か) を返す（repo chunk の峻別・遮断に使う）。

        セッションに repo が紐づいているのに owner の GitHub 連携が消えていれば revoked=True。
        Firestore 不通時は安全側に倒し、repo 紐づけがあるなら revoked 扱いにする。
        対象は GitHub App の ES 索引フローのみ（index_status=none は connector 選択 / env
        フォールバック＝ADR-0027 の seed 経路で、遮断すると正当な seed まで落ちる）。
        """
        try:
            meta = self._repo.get_session(self._session_id)
        except Exception:  # pragma: no cover
            return None, False
        if meta is None or not meta.github_repo:
            return None, False
        if meta.github_index_status is GitHubIndexStatus.NONE:
            return None, False
        try:
            link = self._repo.get_github_link(meta.owner_sub)
        except Exception:  # pragma: no cover
            return meta.github_commit_sha, True
        if link is None:
            return meta.github_commit_sha, True
        return meta.github_commit_sha, False

    @function_tool
    async def propose_session_end(self, _ctx: RunContext) -> dict:
        """確認したい点がすべて解消できたとき、会話を終える提案を出す（P1-b）。

        未解消の論点（矛盾・抜け・不明瞭）が 0 件になったと判断したら呼ぶ。まだ残って
        いれば proposed=false と残数を返すので、深掘りを続ける。0 件なら画面に終了提案の
        カードを出し、ユーザーの同意を音声で確認する（同意を得たら complete_session を呼ぶ）。
        """
        open_count = self._open_detection_count()
        if open_count > 0:
            log.info("session_end_declined_open", session=self._session_id, open=open_count)
            return {"proposed": False, "open_count": open_count, "reason": "open_detections"}
        requirements = len(self._repo.list_requirements(self._session_id))
        if requirements == 0:
            log.info("session_end_declined_no_requirements", session=self._session_id)
            return {"proposed": False, "open_count": 0, "reason": "no_requirements"}
        self._end_proposed = True
        materials = len(self._repo.list_materials(self._session_id))
        if self._publisher is not None:
            await self._publisher.session_end_proposed(
                open_count=0, requirement_count=requirements, material_count=materials
            )
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        log.info("session_end_proposed", session=self._session_id, requirements=requirements)
        return {"proposed": True, "open_count": 0, "requirement_count": requirements}

    @function_tool
    async def complete_session(self, _ctx: RunContext) -> dict:
        """ユーザーが終了に同意したとき、会話を締めてセッションを終える（P1-b）。

        propose_session_end で終了を提案し、ユーザーが「はい」と同意した後にだけ呼ぶ。
        未解消の論点が残っていれば completed=false を返す（同意より整合性を優先）。
        締めの一言を告げてから、少し間をおいて自動的に退出する。
        """
        if self._completed:
            return {"completed": True, "open_count": 0}
        if not self._end_proposed:
            log.info("session_complete_declined_not_proposed", session=self._session_id)
            return {"completed": False, "open_count": 0, "reason": "not_proposed"}
        open_count = self._open_detection_count()
        if open_count > 0:
            log.info("session_complete_declined_open", session=self._session_id, open=open_count)
            return {"completed": False, "open_count": open_count, "reason": "open_detections"}
        self._completed = True
        if self._publisher is not None:
            await self._publisher.session_completed(
                contradictions_resolved=self._publisher.contradictions_resolved,
                gaps_found=self._publisher.gaps_published,
                issues_created=0,
                artifacts=[],
            )
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        log.info("session_completed_by_agent", session=self._session_id)
        if self._shutdown_hook is not None:
            hook = self._shutdown_hook
            delay = settings.voice_completion_shutdown_delay_s

            async def _delayed_shutdown() -> None:
                await asyncio.sleep(delay)
                hook("session completed by agreement")

            self._publish(_delayed_shutdown())
        return {"completed": True, "open_count": 0}

    @function_tool
    async def export_requirements_to_github(self, _ctx: RunContext) -> dict:
        """確定した要件を GitHub Issue として書き出す(コネクタが有効な場合のみ)。

        インタビューの締めくくりで、合意した要件を実装チームに引き継ぐときに使う。
        """
        gh_repo = _resolve_github_repo(self._repo, self._session_id)
        if not _github_ready(gh_repo):
            return {"exported": False, "reason": "github connector disabled"}
        from sanba_shared.models import Audience, check_items_for_audience
        from sanba_shared.output_formats import resolve_output_format
        from sanba_shared.result_document import (
            issue_title,
            render_result_document,
            requirements_to_issue_labels,
            requirements_to_render_dicts,
        )

        from .connectors import GitHubConnector

        requirements = self._repo.list_requirements(self._session_id)
        render_dicts = requirements_to_render_dicts(requirements)
        meta: SessionMeta | None = None
        try:
            meta = self._repo.get_session(self._session_id)
        except Exception:  # pragma: no cover
            pass
        product = _session_product(self._repo, meta)
        template, _ = resolve_output_format(product, Audience.DEVELOPER)
        body = render_result_document(
            template,
            session_title=meta.title if meta is not None else self._session_id,
            app_name=product.name if product is not None else None,
            goal=meta.goal if meta is not None else None,
            date=datetime.now(UTC).strftime("%Y-%m-%d"),
            requirements=render_dicts,
            check_items=(
                check_items_for_audience(product.check_items, Audience.DEVELOPER)
                if product is not None
                else []
            ),
        )
        url = GitHubConnector(settings.github_token, gh_repo).create_issue(
            issue_title(meta.title if meta is not None else self._session_id, self._session_id),
            body,
            labels=requirements_to_issue_labels(render_dicts),
        )
        log.info("requirements_exported", session=self._session_id, repo=gh_repo, url=url)
        if self._publisher is not None and url is not None:
            await self._publisher.session_completed(
                contradictions_resolved=self._publisher.contradictions_resolved,
                gaps_found=self._publisher.gaps_published,
                issues_created=1,
                artifacts=[{"kind": "issue", "url": url}],
            )
        return {"exported": url is not None, "url": url, "count": len(requirements)}


KNOWLEDGE_BASE: list[tuple[str, str]] = [
    (
        "非機能要件は性能・可用性・セキュリティ・拡張性・運用性・コストの観点で確認する。",
        "rfc:nfr-checklist",
    ),
    (
        "要件は MoSCoW(Must/Should/Could/Won't)で優先度付けし、MVPのスコープを最初に固定する。",
        "guide:moscow",
    ),
    (
        "個人情報(PII)を扱う場合は、保存時/通信時の暗号化・最小権限・保持期間を要件化する。",
        "guide:privacy",
    ),
    (
        "性能要件は『誰が・何を・どれくらいの頻度で・どの応答時間で』の形で定量化する。",
        "guide:performance",
    ),
    (
        "曖昧な語(速い・使いやすい等)は測定可能な受け入れ基準に言い換える。",
        "guide:acceptance-criteria",
    ),
]


def seed_knowledge_base(grounding: GroundingStore) -> None:
    for text, source in KNOWLEDGE_BASE:
        grounding.index_passage(
            text=text, source=source, kind="knowledge", doc_id=f"knowledge:{source}"
        )


def _github_ready(repo_name: str) -> bool:
    return bool(settings.github_connector_enabled and settings.github_token and repo_name)


def _resolve_github_repo(repo: SessionRepository, session_id: str) -> str:
    """連携リポジトリを「セッション選択 → 環境変数」の順で解決する（ADR-0027）。

    02 準備で選ばれた値はセッション文書（`sessions/{id}.github_repo`）に載る。
    None（未指定・旧文書）だけ環境変数 GITHUB_REPO へフォールバックし、空文字は
    明示的な「連携しない」なのでそのまま返す（フォールバックしない / Codex P2）。
    空文字は呼び出し側の `_github_ready` が黙って断る。
    """
    try:
        meta = repo.get_session(session_id)
    except Exception as exc:  # pragma: no cover
        log.warning("github_repo_resolve_failed", session=session_id, error=str(exc))
        return ""
    if meta is None:
        log.warning("github_repo_session_missing", session=session_id)
        return ""
    if meta.github_repo is not None:
        return meta.github_repo
    return settings.github_repo


def seed_github_context(
    grounding: GroundingStore, session_id: str, repo: SessionRepository, repo_name: str
) -> None:
    """Pull the session's GitHub repo issues/README into grounding (issue #7 / ADR-0027).

    OFF unless the connector is explicitly enabled, so it never affects the demo path.
    `repo_name` は `_resolve_github_repo`（セッション選択→環境変数）の解決結果を渡す。
    セッションの repo が GitHub App 経由で ES 索引済み/索引中（index_status が none/failed
    以外）の場合は、repo 本体の chunk と README/Issue seed が二重になるためスキップする
    （ADR-0028・Codex P2。検索は session_id だけで通すため重複すると根拠が水増しされる）。
    """
    if not _github_ready(repo_name):
        return
    try:
        meta = repo.get_session(session_id)
        if meta is not None and meta.github_index_status not in (
            GitHubIndexStatus.NONE,
            GitHubIndexStatus.FAILED,
        ):
            log.info("github_seed_skipped_indexed_repo", session=session_id, repo=meta.github_repo)
            return
    except Exception as exc:  # pragma: no cover
        log.warning("github_seed_link_check_failed", error=str(exc))
    try:
        from .connectors import GitHubConnector

        connector = GitHubConnector(settings.github_token, repo_name)
        for text, source in connector.fetch_context_passages():
            grounding.index_passage(text=text, source=source, kind="context", session_id=session_id)
        log.info("github_context_seeded", session=session_id, repo=repo_name)
    except Exception as exc:  # pragma: no cover
        log.warning("github_seed_failed", error=str(exc))


_START_SENSITIVITY = {
    "low": genai_types.StartSensitivity.START_SENSITIVITY_LOW,
    "high": genai_types.StartSensitivity.START_SENSITIVITY_HIGH,
}
_END_SENSITIVITY = {
    "low": genai_types.EndSensitivity.END_SENSITIVITY_LOW,
    "high": genai_types.EndSensitivity.END_SENSITIVITY_HIGH,
}


def build_turn_detection(
    *,
    silence_duration_ms: int,
    end_sensitivity: str,
    start_sensitivity: str,
    prefix_padding_ms: int,
) -> genai_types.RealtimeInputConfig:
    """Gemini Live の自動 VAD 設定を組み立てる（ADR-0038）。

    「参加者が話し終える前にエージェントが被せて話し始める」問題への対策で、
    発話終端の判定を保守側（end_sensitivity=low + 無音時間を長め）に倒す。
    値は env で調整できる（config.Settings の turn_*）。未知の感度値は警告して
    サーバ既定に倒し、設定ミスで接続自体が失敗しないようにする。
    """
    start = _START_SENSITIVITY.get(start_sensitivity.strip().lower())
    end = _END_SENSITIVITY.get(end_sensitivity.strip().lower())
    if start_sensitivity.strip() and start is None:
        log.warning("unknown_turn_start_sensitivity", value=start_sensitivity)
    if end_sensitivity.strip() and end is None:
        log.warning("unknown_turn_end_sensitivity", value=end_sensitivity)
    return genai_types.RealtimeInputConfig(
        automatic_activity_detection=genai_types.AutomaticActivityDetection(
            disabled=False,
            start_of_speech_sensitivity=start,
            end_of_speech_sensitivity=end,
            prefix_padding_ms=prefix_padding_ms if prefix_padding_ms > 0 else None,
            silence_duration_ms=silence_duration_ms if silence_duration_ms > 0 else None,
        )
    )


async def guarded_generate_reply(
    session: AgentSession, *, session_id: str, kind: str, **kwargs: Any
) -> bool:
    """generate_reply を span + 失敗ログ付きで実行する（観測性 / CLAUDE.md 原則3）。

    例外を投げる失敗は session 紐付きの ``voice_reply_failed`` として残す。ただし
    **Gemini Live の generation_created タイムアウトはここでは捕捉できない**: livekit は
    その ``RealtimeError`` を内部タスクで握って listening に戻すだけで、例外も error イベントも
    呼び出し側へ出さない（agent_activity の generate_reply future の except 節）。この「黙って
    一言が落ちる」ケースは開始一言では open_interview が assistant 応答の不在で検知・再試行する。
    例外は呼び出し側へ伝播させない。成否を bool で返す。
    """
    tracer = get_tracer("sanba.voice")
    span_cm = (
        tracer.start_as_current_span("sanba.voice.reply")
        if tracer is not None
        else contextlib.nullcontext()
    )
    with span_cm as span:
        if span is not None:
            span.set_attribute("sanba.voice.reply_kind", kind)
        try:
            await session.generate_reply(**kwargs)
            return True
        except Exception as exc:  # noqa: BLE001
            if span is not None:
                span.set_attribute("sanba.voice.reply_failed", True)
            log.warning("voice_reply_failed", session=session_id, kind=kind, error=str(exc))
            return False


async def open_interview(
    session: AgentSession,
    *,
    session_id: str,
    instructions: str,
    reply_seen: asyncio.Event,
    max_attempts: int | None = None,
    reply_timeout_s: float | None = None,
) -> bool:
    """開始一言（掴み）を、assistant 応答が観測できるまで最大 max_attempts 回試みる（#374）。

    Gemini Live は接続直後に generation_created を返せず、開始一言が黙って落ちることがある
    （sess-2d51da04 / sess-ae759ca3 で再現。livekit は RealtimeError を内部で握って listening に
    戻すだけで、例外も error イベントも出ないため guarded_generate_reply では検知できない）。
    ここでは各試行のあと ``reply_seen``（assistant の conversation_item が来たら set される
    entrypoint 側イベント）を reply_timeout_s だけ待ち、来なければ voice_opening_no_response を
    残して再試行する。再試行前に interrupt して、遅れて生成された一言との二重発話を避ける。
    成功で True、上限まで応答が出なければ False（会話自体は生きており次の発話から前進できる）。
    """
    attempts = max_attempts if max_attempts is not None else settings.voice_opening_max_attempts
    timeout_s = (
        reply_timeout_s if reply_timeout_s is not None else settings.voice_opening_reply_timeout_s
    )
    for attempt in range(1, max(1, attempts) + 1):
        reply_seen.clear()
        await guarded_generate_reply(
            session, session_id=session_id, kind="opening", instructions=instructions
        )
        try:
            await asyncio.wait_for(reply_seen.wait(), timeout=timeout_s)
        except TimeoutError:
            log.warning("voice_opening_no_response", session=session_id, attempt=attempt)
            if attempt < max(1, attempts):
                with contextlib.suppress(Exception):
                    await session.interrupt()
            continue
        if attempt > 1:
            log.info("voice_opening_recovered", session=session_id, attempt=attempt)
        return True
    return False


async def respond_to_user_text(
    agent: SANBAAgent, session: AgentSession, text: str, current_qid: str | None
) -> None:
    """テキスト入力（user.text, 契約 §4.5 / #185）を音声発話と同じ会話ターンとして扱う。

    発話を記録（transcript.final で会話履歴へ反映）し、§5-6 に従い未回答 current を
    クリアした上で、音声のバージインと同様に読み上げ中の応答を中断してから、本文を
    user ターンとして Live セッションの会話文脈へ注入し応答を生成する
    （livekit-agents 既定のテキスト入力コールバックと同じ interrupt + user_input 方式）。
    """
    agent.record_utterance("participant", text)
    if current_qid is not None:
        await agent.clear_current_question(current_qid)
    await session.interrupt()
    await session.generate_reply(user_input=text)


async def respond_to_answer(
    agent: SANBAAgent, session: AgentSession, question_id: str, answer: str
) -> None:
    """通常質問（金枠, #181）への回答を記録し、要件を一歩進める応答を生成する。

    回答を「問い本文つき」で発話記録し（Codex P2）、何への回答か後続の
    analyze_requirements が分かるようにする。テキスト/タップ回答も音声回答と同様、
    読み上げ中なら中断してから応答する（user.text と同じ即時反応）。
    """
    prompt = agent.record_answer(question_id, answer)
    await agent.clear_current_question(question_id)
    topic = f"問い「{prompt}」" if prompt else "先ほどの問い"
    await session.interrupt()
    await session.generate_reply(
        instructions=(
            f"{topic}に対し参加者は「{answer}」と答えました。"
            "これを踏まえて要件を一歩進め、必要なら次の問いを1つだけ投げてください。"
        )
    )


async def inject_video_analysis(
    agent: SANBAAgent, session: AgentSession, asset_id: str, observations: list[str]
) -> None:
    """アップロード動画の解析結果を会話へ能動注入する（ADR-0040 §4）。

    worker が publish した analysis.visual を受けて、エージェントが動画内容に触れて深掘り
    質問を投げられるようにする。ADR-0037 は非同期の会話割り込みを避ける決定だったが、本注入は
    ADR-0040 §4 が analysis.visual に限って許可する。ただし発話を遮らない穏当な注入にする
    （`session.interrupt()` は呼ばない）: 次の発話境界で自然に織り込ませ、読み上げ中の割り込みを
    避ける。dedup・モードゲートは `claim_video_injection` に集約（end_user は注入しない）。
    ルームが閉じていれば generate_reply は失敗するが guarded 側で握る（grounding には投入済み）。
    """
    if not agent.claim_video_injection(asset_id):
        return
    bullets = "\n".join(f"- {o}" for o in observations)
    instructions = (
        "利用者がアップロードした動画の解析結果が届きました。動画から読み取れた観察は次のとおりです。\n"
        f"{bullets}\n"
        "この内容に自然に触れつつ、要件を深掘りする質問を1つだけ、日本語で簡潔に投げてください。"
        "既に会話で扱った点の繰り返しは避けてください。"
    )
    await guarded_generate_reply(
        session, session_id=agent.session_id, kind="video_analysis", instructions=instructions
    )


def _is_livekit_cloud_url(url: str) -> bool:
    """接続先が LiveKit Cloud か（BVC が実効する transport か）を判定する（ADR-0039）。

    Cloud は `wss://<project>.livekit.cloud`。self-host / local（`ws://localhost:7880` 等）は
    Krisp BVC の transport 前提を満たさないため False。判定不能な URL も False（安全側）。
    """
    host = (urlparse(url).hostname or "").lower()
    return host == "livekit.cloud" or host.endswith(".livekit.cloud")


def build_noise_cancellation() -> Any | None:
    """入力音声のノイズ抑制（Krisp BVC）を組み立てる（ADR-0039）。

    設定 ON・プラグイン導入済み・接続先が LiveKit Cloud の 3 条件が揃うときだけ BVC を返し、
    RoomInputOptions.noise_cancellation に渡す。いずれか欠けるときは None を返し、抑制なしで
    会話を続ける（フェイルソフト）。BVC は LiveKit Cloud transport 前提のため、self-host / local
    では初期化できず二重処理・失敗の元になるので自動で無効化する。設定 ON なのに使えない構成
    （プラグイン未導入・非 Cloud）のときは観測性のため一度警告する（CLAUDE.md 原則3）。
    """
    if not settings.noise_cancellation_enabled:
        return None
    if _noise_cancellation is None:
        log.warning("noise_cancellation_unavailable", reason="plugin_not_installed")
        return None
    if not _is_livekit_cloud_url(settings.livekit_url):
        log.warning(
            "noise_cancellation_unavailable",
            reason="not_livekit_cloud",
            livekit_url=settings.livekit_url,
        )
        return None
    return _noise_cancellation.BVC()


def build_input_transcription() -> genai_types.AudioTranscriptionConfig:
    """入力音声の文字起こし設定を組み立てる（ADR-0039）。

    `language_codes` に設定言語（既定 ja-JP）を与えると、Gemini Live は「入力音声はこの
    言語」というヒントとして使い、短い発話・雑音・曖昧な音で韓国語/中国語へ誤認識
    ドリフトするのを抑える。空文字なら language_codes を付けずモデルの自動判定に委ねる
    （従来挙動）。ネイティブ音声モデルでも入力文字起こしのヒントは有効。
    """
    lang = settings.gemini_language.strip()
    return genai_types.AudioTranscriptionConfig(language_codes=[lang] if lang else None)


def build_realtime_model() -> google.beta.realtime.RealtimeModel:
    """Gemini Live の RealtimeModel を組み立てる（ターン検出・安定化・言語固定 / ADR-0038・0039）。

    再起動のたびに新しいインスタンスが要るため関数化している（AgentSession が閉じた
    モデルは再利用できない）。context window compression は、長いインタビューが
    コンテキスト上限でセッションごと打ち切られて無反応になるのを防ぐ。
    ADR-0039: 言語を固定して認識ドリフト（韓国語/中国語化）を抑える。`language`（BCP-47）は
    出力音声の language_code、`input_audio_transcription.language_codes` は入力認識の言語ヒント。
    ネイティブ音声は出力言語を自動選択する面があるため、プロンプト側（VOICE_AGENT_INSTRUCTIONS）
    でも日本語固定を明示し多層で担保する。
    """
    compression: genai_types.ContextWindowCompressionConfig | NotGiven = NOT_GIVEN
    if settings.gemini_context_window_compression:
        compression = genai_types.ContextWindowCompressionConfig(
            trigger_tokens=settings.gemini_context_trigger_tokens,
            sliding_window=genai_types.SlidingWindow(
                target_tokens=settings.gemini_context_sliding_window_tokens
            ),
        )
    language: str | NotGiven = settings.gemini_language.strip() or NOT_GIVEN
    return google.beta.realtime.RealtimeModel(
        model=settings.gemini_live_model,
        voice="Puck",
        language=language,
        temperature=0.7,
        input_audio_transcription=build_input_transcription(),
        realtime_input_config=build_turn_detection(
            silence_duration_ms=settings.turn_silence_duration_ms,
            end_sensitivity=settings.turn_end_sensitivity,
            start_sensitivity=settings.turn_start_sensitivity,
            prefix_padding_ms=settings.turn_prefix_padding_ms,
        ),
        context_window_compression=compression,
    )


def resume_instructions(transcript: list[str], *, tail: int = 10) -> str:
    """セッション再起動後の再開指示を組み立てる（ADR-0038）。

    新しい Gemini Live セッションは会話履歴を持たないため、Python 側で保持している
    transcript の末尾を文脈として渡し、「復旧して続きから」を一言で伝えさせる。
    分析用 transcript（要件抽出の入力）は agent 側に残っているので失われない。
    """
    recent = "\n".join(transcript[-tail:]) if transcript else "（まだ発話はありません）"
    return (
        "通信が一時的に途切れて復旧しました。参加者に一言だけ短くお詫びし、"
        "以下の直前の会話を踏まえて、途中だった話題の続きから会話を再開してください。"
        "最初からやり直したり、同じ質問を繰り返したりしないこと。\n"
        f"直前の会話:\n{recent}"
    )


async def entrypoint(ctx: JobContext) -> None:
    """LiveKit job entrypoint: one invocation per room."""
    setup_observability()
    await ctx.connect()

    session_id = ctx.room.name
    repo = SessionRepository(
        data_retention_days=settings.data_retention_days,
        mask_pii_before_persist=settings.mask_pii_before_index,
    )
    grounding = GroundingStore()
    seed_knowledge_base(grounding)
    publisher = EventPublisher(
        session_id,
        LiveKitTransport(ctx.room),
        start_seq=repo.get_startup_seq(session_id),
        start_lossy_seq=repo.reserve_lossy_seq_base(session_id),
    )
    agent = SANBAAgent(session_id=session_id, repo=repo, grounding=grounding, publisher=publisher)
    if agent.allow_repo_grounding:
        seed_github_context(grounding, session_id, repo, _resolve_github_repo(repo, session_id))
    else:
        log.info(
            "github_seed_skipped",
            session=session_id,
            interview_mode=agent.interview_mode.value,
        )

    _bg_tasks: set[asyncio.Task] = set()

    def _on_bg_done(task: asyncio.Task) -> None:
        _bg_tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()):
            log.warning("web_event_task_failed", error=str(exc))

    def _schedule(coro) -> None:  # type: ignore[no-untyped-def]
        task = asyncio.create_task(coro)
        _bg_tasks.add(task)
        task.add_done_callback(_on_bg_done)

    session: AgentSession
    restart_count = 0
    restart_pending = False
    reply_seen = asyncio.Event()

    def _on_data(packet) -> None:  # type: ignore[no-untyped-def]
        topic = getattr(packet, "topic", None)
        data = getattr(packet, "data", b"")
        if topic == EVENTS_TOPIC:
            visual = decode_analysis_visual(data, expected_session_id=session_id)
            if visual is not None:
                asset_id, observations = visual
                _schedule(inject_video_analysis(agent, session, asset_id, observations))
            return
        if topic != WEB_EVENTS_TOPIC:
            return
        sel = decode_user_selection(data, expected_session_id=session_id)
        if sel is not None:
            detection_id, selected_value = sel
            _schedule(agent.resolve_detection(detection_id, selected_value))
            return
        text = decode_user_text(data, expected_session_id=session_id)
        if text is not None:
            _schedule(respond_to_user_text(agent, session, text, agent.current_question_id))
            return
        answered = decode_user_answered(data, expected_session_id=session_id)
        if answered is not None:
            question_id, answer = answered
            _schedule(respond_to_answer(agent, session, question_id, answer))

    def _wire_session(s: AgentSession) -> None:
        """AgentSession ごとのイベントハンドラを張る（再起動で作り直すたびに呼ぶ / ADR-0038）。"""

        @s.on("user_input_transcribed")
        def _on_user_text(ev) -> None:  # type: ignore[no-untyped-def]
            text = getattr(ev, "transcript", "")
            if not text:
                return
            if getattr(ev, "is_final", False):
                current_qid = agent.current_question_id
                agent.record_user_final(text)
                if current_qid is not None:
                    _schedule(agent.clear_current_question(current_qid))
            else:
                agent.publish_user_partial(text)

        @s.on("conversation_item_added")
        def _on_item_added(ev) -> None:  # type: ignore[no-untyped-def]
            item = getattr(ev, "item", None)
            if getattr(item, "role", None) != "assistant":
                return
            reply_seen.set()
            text = getattr(item, "text_content", None)
            if text:
                agent.publish_agent_utterance(text)

        @s.on("error")
        def _on_session_error(ev: ErrorEvent) -> None:
            log.warning(
                "voice_session_error",
                session=session_id,
                recoverable=getattr(ev.error, "recoverable", None),
                error=str(getattr(ev.error, "error", ev.error)),
            )

        @s.on("close")
        def _on_session_close(ev: CloseEvent) -> None:
            if ev.reason == CloseReason.ERROR:
                _request_restart()

    async def _start_session() -> AgentSession:
        """AgentSession を組み立てて開始する（初回・再起動共通）。

        video_enabled=True forwards screen-share / camera frames to Gemini Live,
        so the agent can read mockups and whiteboards (multimodal grounding).
        開始に失敗した中途半端なセッションは閉じてから raise する（リーク防止）。
        """
        s: AgentSession = AgentSession(llm=build_realtime_model())
        _wire_session(s)
        input_options = RoomInputOptions(
            video_enabled=True,
            noise_cancellation=build_noise_cancellation(),
        )
        try:
            await s.start(
                agent=agent,
                room=ctx.room,
                room_input_options=input_options,
            )
        except BaseException:
            with contextlib.suppress(Exception):
                await s.aclose()
            raise
        return s

    def _request_restart() -> None:
        """再起動を一度だけスケジュールする（close ハンドラと失敗リトライの二重起動防止）。

        開始に失敗したセッションは「_restart_session の except 分岐」と「そのセッション
        自身の close(ERROR)」の両方が再起動を要求し得る。restart_pending で束ね、
        並行して 2 つの AgentSession が同じルームに立つ事故を防ぐ。
        """
        nonlocal restart_pending
        if restart_pending:
            return
        restart_pending = True
        _schedule(_restart_session())

    async def _restart_session() -> None:
        """回復不能エラーで閉じたセッションを作り直す（上限つき・指数バックオフ / ADR-0038）。

        SANBAAgent は close 時に activity が外れるため同一インスタンスを再利用でき、
        transcript・採番・検知の状態は維持される。Gemini 側の会話履歴は新規セッションでは
        失われるので、resume_instructions が直前の transcript 末尾を文脈として渡す。
        """
        nonlocal session, restart_count, restart_pending
        if restart_count >= settings.voice_session_max_restarts:
            log.error(
                "voice_session_restarts_exhausted",
                session=session_id,
                restarts=restart_count,
            )
            ctx.shutdown(reason="voice session unrecoverable")
            return
        restart_count += 1
        delay = settings.voice_session_restart_backoff_s * (2 ** (restart_count - 1))
        log.warning(
            "voice_session_restarting",
            session=session_id,
            attempt=restart_count,
            max_restarts=settings.voice_session_max_restarts,
            delay_s=delay,
        )
        await asyncio.sleep(delay)
        try:
            session = await _start_session()
        except Exception as exc:  # noqa: BLE001
            log.error(
                "voice_session_restart_failed",
                session=session_id,
                attempt=restart_count,
                error=str(exc),
            )
            _schedule(_restart_session())
            return
        restart_pending = False
        log.info("voice_session_restarted", session=session_id, attempt=restart_count)
        try:
            await publisher.status("listening")
            await session.generate_reply(instructions=resume_instructions(agent.transcript))
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "voice_session_resume_reply_failed",
                session=session_id,
                error=str(exc),
            )

    agent.set_shutdown_hook(lambda reason: ctx.shutdown(reason=reason))
    session = await _start_session()
    ctx.room.on("data_received", _on_data)
    await publisher.status("listening")
    await agent.emit_context_progress()

    await open_interview(
        session,
        session_id=session_id,
        instructions=opening_instructions(agent.interview_mode, agent.has_prep_context),
        reply_seen=reply_seen,
    )

    async def _on_close() -> None:
        await _drain_tasks(set(_bg_tasks), DRAIN_GRACE_SECONDS)
        await agent.drain_background_tasks()
        from .evaluation import score_session

        await score_session(session_id=session_id, transcript="\n".join(agent.transcript))

    ctx.add_shutdown_callback(_on_close)


def main() -> None:
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()
