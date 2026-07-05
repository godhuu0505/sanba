"""LiveKit Agents worker entrypoint.

The voice agent joins a LiveKit room and runs a speech-to-speech interview with
Gemini Live. During the conversation it calls the ADK agent team (as a tool) to
plan the next question and to persist confirmed requirements.

Run locally:
    python -m sanba_agent.main dev
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, NamedTuple

import structlog
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    RunContext,
    WorkerOptions,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.plugins import google
from sanba_shared.models import (
    GitHubIndexStatus,
    InviteScope,
    Priority,
    Requirement,
    RequirementCategory,
    SessionMeta,
    Utterance,
)
from sanba_shared.repository import SessionRepository

from .config import settings
from .events import (
    DETECTOR_AMBIGUITY,
    DETECTOR_NFR,
    RESOLUTION_AGENT_RESOLVED,
    RESOLUTION_USER_SELECTED,
    WEB_EVENTS_TOPIC,
    EventPublisher,
    EventPublishError,
    LiveKitTransport,
    decode_user_answered,
    decode_user_selection,
    decode_user_text,
)
from .observability import setup_observability
from .prompts.interview import (
    DEVELOPER_OPENING_INSTRUCTIONS,
    DEVELOPER_OPENING_WITH_PREP_INSTRUCTIONS,
    END_USER_OPENING_INSTRUCTIONS,
    END_USER_VOICE_AGENT_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
    build_glossary_seed,
    build_prep_analysis_note,
    build_prep_premise,
    build_repo_premise,
)
from .retrieval import GroundingStore
from .tools.analysis import analyze_transcript, make_requirement_id

log = structlog.get_logger(__name__)

# Firestore SDK は OS 環境変数 FIRESTORE_EMULATOR_HOST を直接読む。config 経由で指定された
# 場合に SDK へ橋渡しする (api/main.py と同じパターン)。未設定なら本番の実 Firestore に接続。
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


def _glossary_seed(repo: SessionRepository, meta: SessionMeta) -> str:
    """product の利用者向け語彙シードを組み立てる（ADR-0032 決定7 / FR-2.4）。

    product_id → product の順に辿り、読める範囲で機械的に組み立てる（LLM 追加呼び出し
    なし・ADR-0028 の repo 要約シードと同型）。product_id なし（単発セッション）・
    product 削除済み・Firestore 不通では空文字 = シードなしで会話は成立させる
    （シードは付加価値）。glossary 空でもアプリ名はシードする。
    """
    if not meta.product_id:
        return ""
    try:
        product = repo.get_product(meta.product_id)
    except Exception as exc:  # pragma: no cover - depends on backend
        log.warning("glossary_seed_read_failed", session=meta.id, error=str(exc))
        return ""
    if product is None:
        log.warning("glossary_seed_product_missing", session=meta.id)
        return ""
    return build_glossary_seed(product.name, product.glossary)


class AgentSetup(NamedTuple):
    """build_agent_instructions の結果（初期 instructions と付随フラグの束）。"""

    instructions: str
    mode: InviteScope
    allow_repo_grounding: bool
    # 準備フォーム由来の事前情報ノート（ADR-0034）。analyze_requirements の transcript
    # 先頭に付し、ADK の統括・矛盾検知が準備情報とも突き合わせられるようにする。無ければ空。
    prep_note: str


def build_agent_instructions(repo: SessionRepository, session_id: str) -> AgentSetup:
    """モードに応じて voice agent の初期 instructions を組み立てる（ADR-0032 決定6・7）。

    developer: 従来どおり grill-me ペルソナ + repo 前提（ADR-0028）。
    end_user: 利用者向けペルソナ + glossary シード。repo 前提は**シードしない**:
    grounding の出力遮断（決定8）が PR8 で入るまでの暫定フェイルクローズで、
    private repo 由来の情報が利用者の会話に露出する面を作らない（#321）。

    developer では準備フォームのゴール・詳細（ADR-0034）も前提としてシードし、
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
    except Exception as exc:  # pragma: no cover - depends on backend
        log.warning("session_meta_read_failed", session=session_id, error=str(exc))
    mode = meta.interview_mode if meta is not None else InviteScope.DEVELOPER
    prep_note = ""
    if mode is InviteScope.END_USER:
        assert meta is not None  # END_USER は meta が読めたときにしか選ばれない
        instructions = END_USER_VOICE_AGENT_INSTRUCTIONS + _glossary_seed(repo, meta)
        allow_repo_grounding = False
    else:
        # 準備フォームのゴール（ADR-0034）を repo 前提より先にシードする（セッションの主題が
        # 先、repo はその裏付け）。meta が読めないときは repo 前提と同じく付けない。
        prep_premise = ""
        if meta is not None:
            prep_premise = build_prep_premise(meta.goal, meta.goal_detail, meta.roles)
            prep_note = build_prep_analysis_note(meta.goal, meta.goal_detail)
        instructions = (
            VOICE_AGENT_INSTRUCTIONS + prep_premise + (_repo_premise(meta) if confirmed else "")
        )
        allow_repo_grounding = confirmed
    # モード分岐の観測性（CLAUDE.md 原則3）: どのモードでどれだけシードしたかを追える形に。
    log.info(
        "agent_instructions_built",
        session=session_id,
        interview_mode=mode.value,
        mode_confirmed=confirmed,
        allow_repo_grounding=allow_repo_grounding,
        has_prep_context=bool(prep_note),
        chars=len(instructions),
    )
    return AgentSetup(instructions, mode, allow_repo_grounding, prep_note)


def opening_instructions(mode: InviteScope, has_prep_context: bool = False) -> str:
    """接続直後の最初の一問の指示（モード別）。

    developer で準備情報がシード済みなら、ゼロからの聞き取りではなく準備情報の
    認識合わせ→深掘りから始めさせる（ADR-0034）。
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


class SANBAAgent(Agent):
    """The voice interviewer. Owns the tools that bridge to the ADK team."""

    def __init__(
        self,
        session_id: str,
        repo: SessionRepository,
        grounding: GroundingStore,
        publisher: EventPublisher | None = None,
    ) -> None:
        # モード別に初期 instructions を組み立てる（ADR-0032 決定6・7）。developer は
        # grill-me + 準備情報（ADR-0034）+ repo 前提（ADR-0028）、end_user は
        # 利用者ペルソナ + glossary シード。
        setup = build_agent_instructions(repo, session_id)
        super().__init__(instructions=setup.instructions)
        self._interview_mode = setup.mode
        self._allow_repo_grounding = setup.allow_repo_grounding
        # 準備フォームの事前情報ノート（ADR-0034）。analyze_requirements の transcript に前置する。
        self._prep_note = setup.prep_note
        self._session_id = session_id
        self._repo = repo
        self._grounding = grounding
        self._transcript: list[str] = []
        # data channel publish（#94）。未設定でも会話は成立する（publish は付加価値）。
        self._publisher = publisher
        self._utterance_seq = 0
        # 問い発行ごとの連番（question.asked の ID を一意にする / Codex P2）。
        self._question_seq = 0
        # question_id → 問い本文。回答を「何への回答か」分かる形で記録するため保持する
        # （Codex P2。ID は hash+連番で本文を復元できないため）。
        self._questions: dict[str, str] = {}
        # 現在の未回答質問 id（#212 / ADR-0020 §5-6）。自由記述/音声回答には question_id が
        # 無いため、「発話受信時点の current 質問」をこの値で束ねクリア対象を固定する。回答で None。
        self._current_question_id: str | None = None
        # 既に publish 済みの検知 id（open_topic の重複 gap を抑止）。
        self._published_gaps: set[str] = set()
        # 既に publish 済みの不明瞭検知 id（曖昧発話の重複 ambiguous を抑止 / #260）。
        self._published_ambiguous: set[str] = set()
        # fire-and-forget の publish タスクを保持（GC による途中消滅を防ぐ）。
        self._publish_tasks: set[asyncio.Task[Any]] = set()

    @property
    def transcript(self) -> list[str]:
        return self._transcript

    @property
    def interview_mode(self) -> InviteScope:
        """このセッションのインタビュー・モード（ADR-0032 決定6。entrypoint が参照）。"""
        return self._interview_mode

    @property
    def has_prep_context(self) -> bool:
        """準備フォームの事前情報がシード済みか（ADR-0034。開始指示の分岐に使う）。"""
        return bool(self._prep_note)

    @property
    def allow_repo_grounding(self) -> bool:
        """repo 由来素材（GitHub seed）を許すか。モード確認済みの非 end_user のみ True。"""
        return self._allow_repo_grounding

    @property
    def current_question_id(self) -> str | None:
        """現在の未回答質問 id（#212 §5-6。発話受信時点で束ねるために読む）。"""
        return self._current_question_id

    def _publish(self, coro) -> None:  # type: ignore[no-untyped-def]
        """同期コンテキストから publish をスケジュールする（seq は publisher 側で直列化）。"""
        if self._publisher is None:
            coro.close()
            return
        # create_task の戻り値を保持しないとタスクが GC で途中消滅し得る（CPython の既知挙動）。
        # 集合で強参照を保ち、完了時に取り除く。
        task = asyncio.create_task(coro)
        self._publish_tasks.add(task)
        task.add_done_callback(self._on_publish_done)

    def _on_publish_done(self, task: asyncio.Task[Any]) -> None:
        self._publish_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.warning("publish_task_failed", error=str(task.exception()))

    def record_utterance(self, speaker: str, text: str) -> str:
        # 発話 id を先に採番し、本文に前置して LLM に見せる。これにより
        # save_requirement の citations（根拠発話 id）を LLM が実際に参照できる（#133）。
        self._utterance_seq += 1
        utterance_id = f"u{self._utterance_seq}"
        self._transcript.append(f"[{utterance_id}] {speaker}: {text}")
        self._repo.add_utterance(self._session_id, Utterance(speaker=speaker, text=text))
        # Index for later past-session retrieval.
        self._grounding.index_passage(
            text=text,
            source=f"{self._session_id}:{speaker}",
            kind="utterance",
            session_id=self._session_id,
        )
        # 確定発話を web へ（04/05 のトランスクリプト・detection.refs の ID 空間）。
        if self._publisher is not None:
            role = "participant"
            self._publish(self._publisher.transcript_final(speaker, role, utterance_id, text))
        return utterance_id

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
        # 永続化して open スナップショットから外す（リロード後も未解消に戻さない）。
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
        transcript = "\n".join(self._transcript)
        # 準備フォームの事前情報を先頭に付す（ADR-0034）。ADK の統括・矛盾検知が
        # 「準備時の記入」対「会話中の回答」の食い違いも検出できるようにする。
        if self._prep_note:
            transcript = f"{self._prep_note}\n{transcript}"
        if self._publisher is not None:
            await self._publisher.status("deliberating")
        result = await analyze_transcript(transcript)
        log.info(
            "analysis",
            session=self._session_id,
            open_topics=result.open_topics,
            next_question=result.next_question,
        )
        # 抜け（未確認の論点）を detection.gap として web に上げる（05/08 の黄土）。
        # TODO: open_topics の種別（機能/非機能）を判定して category/detector を振り分ける。
        #       現状は暫定で一律 non_functional / DETECTOR_NFR を使用しており、
        #       機能スコープの抜けも NFR として表示される点に注意。
        if self._publisher is not None:
            current = {make_requirement_id(f"gap:{t}"): t for t in result.open_topics}
            # 新規の抜けを永続化 + publish（リロードでも復元できるよう Firestore に保存）。
            for gap_id, topic in current.items():
                if gap_id in self._published_gaps:
                    continue
                self._published_gaps.add(gap_id)
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
            # 会話で埋まり open_topics から外れた抜けは agent_resolved で閉じる（音声回答の反映）。
            for gap_id in list(self._published_gaps):
                if gap_id not in current:
                    self._published_gaps.discard(gap_id)
                    self._repo.resolve_detection(
                        self._session_id, gap_id, RESOLUTION_AGENT_RESOLVED
                    )
                    await self._publisher.detection_resolved(
                        gap_id, resolution=RESOLUTION_AGENT_RESOLVED
                    )
            # 不明瞭（曖昧な言い回し）を detection.ambiguous で上げる（#260 / ADR-0022）。
            # gap と同じく id は内容ハッシュ（#121）、重複は _published_ambiguous で抑止。
            current_ambiguous = {
                make_requirement_id(f"ambiguous:{t}"): t for t in result.ambiguous_topics
            }
            for amb_id, snippet in current_ambiguous.items():
                if amb_id in self._published_ambiguous:
                    continue
                self._published_ambiguous.add(amb_id)
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
            # 会話で具体化され曖昧でなくなった論点は agent_resolved で閉じる。
            for amb_id in list(self._published_ambiguous):
                if amb_id not in current_ambiguous:
                    self._published_ambiguous.discard(amb_id)
                    self._repo.resolve_detection(
                        self._session_id, amb_id, RESOLUTION_AGENT_RESOLVED
                    )
                    await self._publisher.detection_resolved(
                        amb_id, resolution=RESOLUTION_AGENT_RESOLVED
                    )
            await self._publisher.status("listening")
            self._repo.set_session_seq(self._session_id, self._publisher.seq)
        return result.model_dump(mode="json")

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
        # 発行ごとに一意な ID にする（Codex P2）。同じ文面を再質問しても web 側の
        # answeredQuestions（回答済み ID）に当たらず、新しい問いとして再表示できる。
        self._question_seq += 1
        question_id = f"{make_requirement_id(f'q:{prompt}')}-{self._question_seq}"
        # 回答記録時に問い本文を引けるよう保持（Codex P2）。
        self._questions[question_id] = prompt
        opts = [{"label": o, "value": o} for o in (options or [])]
        # §5-6: 自由記述/音声回答（question_id なし）のクリア対象を束ねる現在質問 id。
        self._current_question_id = question_id
        if self._publisher is not None:
            # question.asked はハイドレーション・スナップショット（GET /requirements,/detections）に
            # 含まれない一過性イベント。ここで last_seq を進めると、後続の再ハイドレーションで
            # 境界以下として正当な差分を取り逃すため、seq 境界は進めない（Codex P2）。
            # ADR-0020 §5-1: 採番 → 保存（現在質問ポインタ）→ 送信。on_persist で asked_seq つきの
            # 現在質問を Firestore に保存してから data-channel publish する（GET /questions/current
            # でリロード/途中参加時に金枠ピンを復元できるよう、送信前に確定させる）。
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
                # §5-1: 保存失敗時は送らず seq も消費しない（_emit_guarded が保証）。会話は止めず
                # 続行する。金枠ピンはこの問いでは復元できないが、音声の問いかけは成立している。
                # current 追跡も巻き戻す: 保存できなかった id を指したままだと、後続の発話が毎回
                # CAS 不一致のクリアを試みてログノイズを積む（保存できた問いだけ current とする）。
                self._current_question_id = None
                log.warning(
                    "question_persist_failed",
                    session=self._session_id,
                    id=question_id,
                    error=str(exc),
                )
        log.info("question_asked", session=self._session_id, id=question_id, options=len(opts))
        return {"asked": question_id}

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
            # 順序は 予約 → tombstone commit → publish（§5-9）。id 不一致/既クリアなら False で
            # publish しない（採番もしない）。
            return self._repo.clear_current_question(self._session_id, question_id, cleared_seq)

        cleared = False
        try:
            env = await self._publisher.question_cleared(question_id, on_persist=_persist_tombstone)
            cleared = env is not None
        except EventPublishError as exc:
            # §5-9: tombstone は commit 済み。live 伝播の失敗はハイドレーション GET（再接続/欠番
            # 検知）で確実に復元される。ここでは握りつぶさずログに残す（best-effort の live 反映）。
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
            # 言葉×画の解析結果（08）と、そこから起票した要件（08/09）を web へ。
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
        """
        # session_id を渡してセッション固有素材（context: ゴール/資料/紐づけ repo）を本セッション
        # に限定する（他者の private リポジトリ断片の越境ヒットを防ぐ / ADR-0028）。
        # 紐づけ repo を素早く選び直すと、旧 commit の chunk が索引中に書き込まれて残り得る。
        # 現在の commit sha を持つ repo chunk 以外は落とし、stale な断片を会話に出さない
        # （Codex P2。source は github:{repo}@{branch}@{sha}:{path} 形式で sha を内包）。
        # stale 除外で上位が削られても現在 repo の有効 chunk が残るよう、多めに取得してから絞る。
        # owner が連携解除/権限剥奪したら、索引済み repo chunk を検索時に遮断する（query-time
        # access control / ADR-0028・Codex P2）。共有索引は消さない方針なので、ここで弾く。
        want = 4
        current_sha, revoked = self._repo_access()
        fetch_k = want * 4 if (current_sha is not None or revoked) else want
        passages = self._grounding.search(query, k=fetch_k, session_id=self._session_id)
        if revoked:
            # 連携が無効: あらゆる repo 索引 chunk（github:）を落とす。
            passages = [p for p in passages if not p.source.startswith("github:")]
        elif current_sha is not None:
            passages = [p for p in passages if not _is_stale_repo_passage(p.source, current_sha)]
        passages = passages[:want]
        log.info("grounding_search", session=self._session_id, query=query, hits=len(passages))
        return {
            "passages": [
                {"text": p.text, "source": p.source, "kind": p.kind, "score": p.score}
                for p in passages
            ]
        }

    def _repo_access(self) -> tuple[str | None, bool]:
        """(現在の commit sha, 連携無効か) を返す（repo chunk の峻別・遮断に使う）。

        セッションに repo が紐づいているのに owner の GitHub 連携が消えていれば revoked=True。
        Firestore 不通時は安全側に倒し、repo 紐づけがあるなら revoked 扱いにする。
        対象は GitHub App の ES 索引フローのみ（index_status=none は connector 選択 / env
        フォールバック＝ADR-0027 の seed 経路で、遮断すると正当な seed まで落ちる）。
        """
        try:
            meta = self._repo.get_session(self._session_id)
        except Exception:  # pragma: no cover - depends on backend
            return None, False
        if meta is None or not meta.github_repo:
            return None, False
        if meta.github_index_status is GitHubIndexStatus.NONE:
            return None, False
        try:
            link = self._repo.get_github_link(meta.owner_sub)
        except Exception:  # pragma: no cover - depends on backend
            return meta.github_commit_sha, True
        if link is None:
            return meta.github_commit_sha, True
        return meta.github_commit_sha, False

    @function_tool
    async def export_requirements_to_github(self, _ctx: RunContext) -> dict:
        """確定した要件を GitHub Issue として書き出す(コネクタが有効な場合のみ)。

        インタビューの締めくくりで、合意した要件を実装チームに引き継ぐときに使う。
        """
        # 起票先は 02 準備で選んだセッションのリポジトリを最優先する（ADR-0027）。
        gh_repo = _resolve_github_repo(self._repo, self._session_id)
        if not _github_ready(gh_repo):
            return {"exported": False, "reason": "github connector disabled"}
        from .connectors import GitHubConnector, requirements_to_issue_body

        requirements = self._repo.list_requirements(self._session_id)
        title, body = requirements_to_issue_body(requirements, self._session_id)
        url = GitHubConnector(settings.github_token, gh_repo).create_issue(title, body)
        log.info("requirements_exported", session=self._session_id, repo=gh_repo, url=url)
        if self._publisher is not None and url is not None:
            # ループの締め（09→10）。スタッツは publish 済みの実測から組み立てる
            # （gaps_found は抜けのみ、contradictions_resolved は解消済みの矛盾のみ）。
            await self._publisher.session_completed(
                contradictions_resolved=self._publisher.contradictions_resolved,
                gaps_found=self._publisher.gaps_published,
                issues_created=1,
                artifacts=[{"kind": "issue", "url": url}],
            )
        return {"exported": url is not None, "url": url, "count": len(requirements)}


# Requirements-engineering knowledge base used to ground the agent's questions.
# In production this is seeded once into Elasticsearch (see scripts/seed_kb); in
# local/dev (memory-backed store) we seed inline so grounding works out of the box.
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
    if not grounding.is_memory:
        return  # production KB is seeded out-of-band to avoid duplicate indexing
    for text, source in KNOWLEDGE_BASE:
        grounding.index_passage(text=text, source=source, kind="knowledge")


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
    except Exception as exc:  # pragma: no cover - Firestore 障害でも本流（会話）は止めない
        # 選択値を確認できないときは既定リポへ流さず連携を無効側へ倒す（Codex P2:
        # 別リポを選んだセッションの要件・文脈が意図しない既定リポへ送られる事故を防ぐ）。
        log.warning("github_repo_resolve_failed", session=session_id, error=str(exc))
        return ""
    if meta is None:
        # セッション文書が無い（未作成/削除済み/誤設定の空ストア）= 選択値を確認できない。
        # 既定リポへ流さず連携を無効側へ倒す（Codex P2 / fail-closed）。
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
    except Exception as exc:  # pragma: no cover - depends on backend
        log.warning("github_seed_link_check_failed", error=str(exc))
    try:
        from .connectors import GitHubConnector

        connector = GitHubConnector(settings.github_token, repo_name)
        for text, source in connector.fetch_context_passages():
            grounding.index_passage(text=text, source=source, kind="context", session_id=session_id)
        log.info("github_context_seeded", session=session_id, repo=repo_name)
    except Exception as exc:  # pragma: no cover - network/optional
        log.warning("github_seed_failed", error=str(exc))


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
    # data channel publish（#94）。音声と同一ルーム接続を再利用して web へ差分を流す。
    # reliable seq は last_seq と current question の asked_seq/cleared_seq の最大値でシード
    # （#123・#270）。question.asked/cleared は set_session_seq を呼ばず pub._seq を消費するため、
    # 再起動後に seq が後退して web の status ガードに弾かれないよう get_startup_seq で揃える。
    # lossy seq は epoch ブロック基底でシードし大域単調にする（#270）。
    publisher = EventPublisher(
        session_id,
        LiveKitTransport(ctx.room),
        start_seq=repo.get_startup_seq(session_id),
        start_lossy_seq=repo.reserve_lossy_seq_base(session_id),
    )
    agent = SANBAAgent(session_id=session_id, repo=repo, grounding=grounding, publisher=publisher)
    # repo 由来素材（GitHub seed）はモード判定と同じ 1 回の読み（build_agent_instructions）に
    # 従う: end_user とモード不明では**シードしない**（ADR-0032 決定8 の出力遮断が PR8 で
    # 入るまでの暫定フェイルクローズ / #321。README/Issue 断片が search_grounding 経由で
    # 利用者の会話に露出する面を作らない）。確認済み developer のみ従来どおり。
    if agent.allow_repo_grounding:
        seed_github_context(grounding, session_id, repo, _resolve_github_repo(repo, session_id))
    else:
        log.info(
            "github_seed_skipped",
            session=session_id,
            interview_mode=agent.interview_mode.value,
        )

    session: AgentSession = AgentSession(
        llm=google.beta.realtime.RealtimeModel(
            model=settings.gemini_live_model,
            voice="Puck",
            temperature=0.7,
        ),
    )

    # Persist user turns so the ADK team always has the full transcript.
    @session.on("user_input_transcribed")
    def _on_user_text(ev) -> None:  # type: ignore[no-untyped-def]
        if getattr(ev, "is_final", False) and ev.transcript:
            speaker = "participant"
            # §5-6: 受信時点の current 質問 id を束ねてから記録する。未回答の current がある間に
            # 届いた音声発話は、その問いへの回答とみなして（options の有無に依らず）クリアする。
            current_qid = agent.current_question_id
            agent.record_utterance(speaker, ev.transcript)
            if current_qid is not None:
                _schedule(agent.clear_current_question(current_qid))

    # web → agent の操作イベントを受信する（契約 §4.5）。
    #   - user.selection（#102）: 検知カードの選択肢タップ → 検知を解消。
    #   - user.text（#185）: テキスト入力 → 発話として記録し音声で応答（会話ターン化）。
    #   - user.answered（#181）: 通常質問への回答 → 発話として記録し次の問いへ進む。
    # fire-and-forget タスクは set に退避して GC を防ぐ（#128。完了時に除去・例外をログ）。
    _bg_tasks: set[asyncio.Task] = set()

    def _on_bg_done(task: asyncio.Task) -> None:
        _bg_tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()):
            log.warning("web_event_task_failed", error=str(exc))

    def _schedule(coro) -> None:  # type: ignore[no-untyped-def]
        task = asyncio.create_task(coro)
        _bg_tasks.add(task)
        task.add_done_callback(_on_bg_done)

    async def _respond_to_user_text(text: str, current_qid: str | None) -> None:
        # テキスト入力を会話ターンとして扱う（#185）。発話を記録（transcript.final で会話履歴へ
        # 反映）し、それを踏まえて音声で応答する。従来のセッション文脈投入（捨て足場）を置換。
        agent.record_utterance("participant", text)
        # §5-6: options の有無に依らず、未回答 current への次回答とみなしてクリアする
        # （current_qid は受信時点で束ねた id。CAS が id 一致時のみクリアする）。
        if current_qid is not None:
            await agent.clear_current_question(current_qid)
        await session.generate_reply(
            instructions=(
                f"参加者がテキストで次のように述べました：「{text}」。"
                "これを会話の発話として受け止め、必要なら一問だけ掘り下げて応答してください。"
            )
        )

    async def _respond_to_answer(question_id: str, answer: str) -> None:
        # 通常質問（金枠）への回答（#181）。回答を「問い本文つき」で発話記録し（Codex P2）、
        # 何への回答か後続の analyze_requirements が分かるようにしてから要件を一歩進める。
        prompt = agent.record_answer(question_id, answer)
        # §5-3: タップ回答は question_id 一致時に CAS でクリア（早期クリア経路）。これで
        # 回答済みの問いが再ハイドレーション（GET /questions/current）で復活しない。
        await agent.clear_current_question(question_id)
        topic = f"問い「{prompt}」" if prompt else "先ほどの問い"
        await session.generate_reply(
            instructions=(
                f"{topic}に対し参加者は「{answer}」と答えました。"
                "これを踏まえて要件を一歩進め、必要なら次の問いを1つだけ投げてください。"
            )
        )

    def _on_data(packet) -> None:  # type: ignore[no-untyped-def]
        if getattr(packet, "topic", None) != WEB_EVENTS_TOPIC:
            return
        data = getattr(packet, "data", b"")
        # session_id を照合し、同室の別セッション向けイベント混入を弾く（#132）。
        sel = decode_user_selection(data, expected_session_id=session_id)
        if sel is not None:
            detection_id, selected_value = sel
            _schedule(agent.resolve_detection(detection_id, selected_value))
            return
        text = decode_user_text(data, expected_session_id=session_id)
        if text is not None:
            # §5-6: 受信時点（同期コールバック内）の current 質問 id を束ねて渡す。後続の非同期
            # 処理が遅れる間に current が別の問いへ上書きされても、CAS が id 一致時のみクリアする。
            _schedule(_respond_to_user_text(text, agent.current_question_id))
            return
        answered = decode_user_answered(data, expected_session_id=session_id)
        if answered is not None:
            question_id, answer = answered
            _schedule(_respond_to_answer(question_id, answer))

    ctx.room.on("data_received", _on_data)

    # video_enabled=True forwards screen-share / camera frames to Gemini Live,
    # so the agent can read mockups and whiteboards (multimodal grounding).
    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(video_enabled=True),
    )
    # 接続直後に web の状態表示を「聴いています」に同期する（03/04/05）。
    await publisher.status("listening")
    # 最初の一問はモード別（ADR-0032 決定6・7）: developer は要件整理＋画面共有の案内、
    # end_user は利用体験の困りごとを技術用語なしで聞く。
    await session.generate_reply(
        instructions=opening_instructions(agent.interview_mode, agent.has_prep_context)
    )

    # When the room closes, score the interview (LLM-as-a-judge) and log to Langfuse.
    async def _on_close() -> None:
        from .evaluation import score_session

        await score_session(session_id=session_id, transcript="\n".join(agent.transcript))

    ctx.add_shutdown_callback(_on_close)


def main() -> None:
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()
