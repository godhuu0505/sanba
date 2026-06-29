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
from typing import Any

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
    Priority,
    Requirement,
    RequirementCategory,
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
from .prompts.interview import VOICE_AGENT_INSTRUCTIONS, build_repo_premise
from .retrieval import GroundingStore
from .tools.analysis import analyze_transcript, make_requirement_id

log = structlog.get_logger(__name__)

# Firestore SDK は OS 環境変数 FIRESTORE_EMULATOR_HOST を直接読む。config 経由で指定された
# 場合に SDK へ橋渡しする (api/main.py と同じパターン)。未設定なら本番の実 Firestore に接続。
if settings.firestore_emulator_host:
    os.environ.setdefault("FIRESTORE_EMULATOR_HOST", settings.firestore_emulator_host)


def _repo_premise(repo: SessionRepository, session_id: str) -> str:
    """SessionMeta を読み、紐づけ repo の前提一節を返す（無ければ空文字 / ADR-0025）。

    索引状態が ready/partial/indexing のときだけ前提化する（none/failed は付けない）。
    Firestore 不通などで読めない場合も会話は成立させる（前提は付加価値）。
    """
    try:
        meta = repo.get_session(session_id)
    except Exception as exc:  # pragma: no cover - depends on backend
        log.warning("repo_premise_session_read_failed", error=str(exc))
        return ""
    if meta is None or not meta.github_repo:
        return ""
    status = meta.github_index_status
    if status in (GitHubIndexStatus.NONE, GitHubIndexStatus.FAILED):
        return ""
    ready = status in (GitHubIndexStatus.READY, GitHubIndexStatus.PARTIAL)
    return build_repo_premise(meta.github_repo, meta.github_branch, ready, meta.github_summary)


def _is_stale_repo_passage(source: str, current_sha: str) -> bool:
    """repo 索引 chunk のうち現在の commit sha 以外を stale と判定する（ADR-0025）。

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
        # 紐づけ GitHub リポジトリがあれば「前提」を初期 instructions にシードする（ADR-0025）。
        # retrieval 任せにせず proactive に前提化し、詳細は search_grounding で掘らせる。
        instructions = VOICE_AGENT_INSTRUCTIONS + _repo_premise(repo, session_id)
        super().__init__(instructions=instructions)
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
        # に限定する（他者の private リポジトリ断片の越境ヒットを防ぐ / ADR-0025）。
        passages = self._grounding.search(query, k=4, session_id=self._session_id)
        # 紐づけ repo を素早く選び直すと、旧 commit の chunk が索引中に書き込まれて残り得る。
        # 現在の commit sha を持つ repo chunk 以外は落とし、stale な断片を会話に出さない
        # （Codex P2。source は github:{repo}@{branch}@{sha}:{path} 形式で sha を内包）。
        current_sha = self._current_repo_sha()
        if current_sha is not None:
            passages = [p for p in passages if not _is_stale_repo_passage(p.source, current_sha)]
        log.info("grounding_search", session=self._session_id, query=query, hits=len(passages))
        return {
            "passages": [
                {"text": p.text, "source": p.source, "kind": p.kind, "score": p.score}
                for p in passages
            ]
        }

    def _current_repo_sha(self) -> str | None:
        """セッションに紐づいた repo の現在 commit sha（stale repo chunk の峻別に使う）。"""
        try:
            meta = self._repo.get_session(self._session_id)
        except Exception:  # pragma: no cover - depends on backend
            return None
        return meta.github_commit_sha if meta is not None else None

    @function_tool
    async def export_requirements_to_github(self, _ctx: RunContext) -> dict:
        """確定した要件を GitHub Issue として書き出す(コネクタが有効な場合のみ)。

        インタビューの締めくくりで、合意した要件を実装チームに引き継ぐときに使う。
        """
        if not _github_ready():
            return {"exported": False, "reason": "github connector disabled"}
        from .connectors import GitHubConnector, requirements_to_issue_body

        requirements = self._repo.list_requirements(self._session_id)
        title, body = requirements_to_issue_body(requirements, self._session_id)
        url = GitHubConnector(settings.github_token, settings.github_repo).create_issue(title, body)
        log.info("requirements_exported", session=self._session_id, url=url)
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


def _github_ready() -> bool:
    return bool(
        settings.github_connector_enabled and settings.github_token and settings.github_repo
    )


def seed_github_context(
    grounding: GroundingStore, session_id: str, repo: SessionRepository
) -> None:
    """Pull a configured GitHub repo's issues/README into grounding (issue #7).

    OFF unless the connector is explicitly enabled, so it never affects the demo path.
    セッションに GitHub App の repo が紐づいている場合は、グローバル `GITHUB_REPO` の
    断片が選択 repo の前提に混ざるのを避けるため旧 connector seed をスキップする
    （ADR-0025・Codex P2。検索は session_id だけで通すため混在すると誤った根拠になる）。
    """
    if not _github_ready():
        return
    try:
        meta = repo.get_session(session_id)
        if meta is not None and meta.github_repo:
            log.info("github_seed_skipped_linked_repo", session=session_id, repo=meta.github_repo)
            return
    except Exception as exc:  # pragma: no cover - depends on backend
        log.warning("github_seed_link_check_failed", error=str(exc))
    try:
        from .connectors import GitHubConnector

        connector = GitHubConnector(settings.github_token, settings.github_repo)
        for text, source in connector.fetch_context_passages():
            grounding.index_passage(text=text, source=source, kind="context", session_id=session_id)
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
    seed_github_context(grounding, session_id, repo)
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
    await session.generate_reply(
        instructions=(
            "まず自己紹介し、これから要件を一緒に整理することを伝え、"
            "画面共有やモックがあれば見せてほしいと案内した上で、"
            "最初の問いを1つだけ、推奨回答例を添えて投げかけてください。"
        )
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
