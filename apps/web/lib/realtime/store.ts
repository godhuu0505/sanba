// 共有 realtime イベントストア（Epic #93 / Issue #101）。
//
// 3つの P0 画面（05 検知 / 08 解析 / 09 要件絵巻）が共通で必要とする受信状態を
// 1か所に集約する。各画面で別々に購読層を書くと 3重複・マージ衝突するため、ここで
// 共有化する（並列化の要）。
//
// 契約（docs/design/realtime-contract.md §2）の適用規則:
//   - `(type, id)` で冪等（同じ要件/検知は upsert）
//   - `seq` で順序を担保（単調増加・整列）
//   - 同一 seq の再配信は重複排除、欠番は検知して再ハイドレーションの契機にする
//
// フレームワーク非依存（React 非依存）にして単体テスト可能にし、UI へは
// useSyncExternalStore 互換の subscribe / getSnapshot で公開する。

import { RealtimeMetrics } from "./metrics";
import type {
  AnalysisVisualConflict,
  Detection,
  Question,
  Requirement,
  ServerEvent,
  SessionPhase,
} from "./types";

export interface AnalysisState {
  asset_id: string;
  pct: number;
  stage: string;
  extracted: string[];
  conflicts: AnalysisVisualConflict[];
}

export interface TranscriptLine {
  utterance_id: string;
  speaker: string;
  role: string;
  text: string;
  /** 確定済みか（false は認識中の partial）。 */
  final: boolean;
}

export interface SessionCompletion {
  contradictions_resolved: number;
  gaps_found: number;
  issues_created: number;
  artifacts: { kind: string; url: string }[];
}

/** UI に公開する不変スナップショット。参照が変わったときだけ再描画される。 */
export interface SessionState {
  phase: SessionPhase;
  agentsActive: number;
  /** 確定/下書き要件。受信順（seq 昇順）。 */
  requirements: Requirement[];
  /** 検知（矛盾/抜け）。seq 昇順。UI ではスタックの最新を前面にする。 */
  detections: Detection[];
  /** 確定発話 + 認識中 partial。utterance_id 単位。 */
  transcript: TranscriptLine[];
  /** 素材 asset_id ごとの解析状態。 */
  analysis: AnalysisState[];
  /** 直近の通常質問（金枠 / #181）。新しい question.asked で置き換わる。未提示なら null。 */
  question: Question | null;
  completed: SessionCompletion | null;
  /** 適用済みの最大 seq（ハイドレーション境界の判定に使う）。 */
  seq: number;
}

interface Versioned<T> {
  seq: number;
  value: T;
}

const EMPTY_STATE: SessionState = {
  phase: "idle",
  agentsActive: 0,
  requirements: [],
  detections: [],
  transcript: [],
  analysis: [],
  question: null,
  completed: null,
  seq: 0,
};

export class RealtimeStore {
  private requirements = new Map<string, Versioned<Requirement>>();
  private detections = new Map<string, Versioned<Detection>>();
  private transcript = new Map<string, Versioned<TranscriptLine>>();
  private analysis = new Map<string, Versioned<AnalysisState>>();
  private phase: SessionPhase = "idle";
  private agentsActive = 0;
  private question: Question | null = null;
  private completed: SessionCompletion | null = null;

  /** ハイドレーションのスナップショット境界 seq。これ以下のライブイベントは破棄。 */
  private hydrationSeq = 0;
  /** 観測した最大 seq（欠番検知用）。 */
  private maxSeq = 0;
  /** 最後に適用した status の seq。古い status による phase 巻き戻しを防ぐ。 */
  private lastStatusSeq = 0;
  /** 最後に適用した session.completed の seq。再配信による巻き戻しを防ぐ。 */
  private lastCompletedSeq = 0;
  /** 最後に適用した question.asked の seq。古い質問による差し戻しを防ぐ。 */
  private lastQuestionSeq = 0;
  /** このストアが受理するセッション ID。不一致イベントは破棄（同室の偽装対策）。 */
  private expectedSessionId: string | null = null;

  private cached: SessionState | null = null;
  private listeners = new Set<() => void>();
  private gapListeners = new Set<() => void>();

  constructor(readonly metrics: RealtimeMetrics = new RealtimeMetrics()) {}

  /** 受理するセッション ID を固定する。設定後は他セッションのイベントを破棄する。 */
  setExpectedSessionId(sessionId: string): void {
    this.expectedSessionId = sessionId;
  }

  /**
   * 欠番を検知したときに呼ばれる購読を登録する。契約 §4 では欠番時に GET で
   * 取り直す前提なので、hook 側でここを使って再ハイドレーションを発火させる。
   */
  onGapDetected(listener: () => void): () => void {
    this.gapListeners.add(listener);
    return () => this.gapListeners.delete(listener);
  }

  // ── React 連携（useSyncExternalStore） ─────────────────────────────
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionState => {
    if (this.cached === null) this.cached = this.build();
    return this.cached;
  };

  private invalidate(): void {
    this.cached = null;
    for (const l of this.listeners) l();
  }

  // ── ハイドレーション（契約 §4） ────────────────────────────────────
  /**
   * GET /requirements のスナップショットを取り込み、境界 seq を確定する。
   * これ以降は seq > hydrationSeq のライブ差分だけを適用する（空白・重複ゼロ）。
   */
  hydrateRequirements(items: Requirement[], seq: number): void {
    for (const r of items) {
      const prev = this.requirements.get(r.id);
      // スナップショットより新しいライブ差分が先着していたら上書きしない。
      if (prev && prev.seq > seq) continue;
      this.requirements.set(r.id, { seq, value: r });
    }
    this.hydrationSeq = Math.max(this.hydrationSeq, seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  /**
   * GET /questions/current の現在質問を取り込む（契約 §4 / #212 / ADR-0020 §5-2/§5-4/§5-11）。
   *
   * - `question`（非 null）も `null`（回答済み/未提示）も、`seq > lastQuestionSeq` のときだけ
   *   適用する。これにより「古い current を読んだ遅延 GET が、先に適用済みの新しい live
   *   `question.asked` を巻き戻す / 遅延 null が新しい問いを消す」逆転を防ぐ（§5-2 / §5-4）。
   * - 適用したら `this.question`（値 or null）と `lastQuestionSeq` を更新する。
   * - `lastQuestionSeq`（question 専用ガード）は常に進めてよいが、**global `maxSeq` は主スナップ
   *   ショット GET（/requirements・必要なら /detections）が全て成功したときだけ**進める
   *   （`advanceMaxSeq`）。主 GET 失敗時に question 由来 seq で `maxSeq` を進めると、切断中に
   *   取り逃した requirement/detection 差分の gap を隠してしまう（§5-11）。
   * - `maxSeq` の前進は「適用の有無に依らず」行う（誤 gap 防止 / §5-2 後段）。
   * - `hydrationSeq`（live 破棄境界）は question が seq 境界を進めない方針に合わせて触らない（§3）。
   */
  hydrateQuestion(question: Question | null, seq: number, advanceMaxSeq: boolean): void {
    if (seq > this.lastQuestionSeq) {
      this.question = question;
      this.lastQuestionSeq = seq;
    }
    if (advanceMaxSeq) this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  /** GET /detections?open=1 の未解消検知を取り込む（契約 §4 P1）。 */
  hydrateDetections(items: Detection[], seq: number): void {
    const freshIds = new Set(items.map((d) => d.id));
    for (const d of items) {
      const prev = this.detections.get(d.id);
      if (prev && prev.seq > seq) continue;
      this.detections.set(d.id, { seq, value: d });
    }
    // GET から消えた open カードは resolved 扱いに同期する。
    // （切断・gap 中に detection.resolved を取り逃した場合の補正。）
    // seq <= seq の条件でスナップショット以前のエントリのみ対象にし、
    // スナップショット取得後に届いた live イベント由来のカードには触れない。
    for (const [key, entry] of this.detections.entries()) {
      if (!entry.value.resolved && !freshIds.has(key) && entry.seq <= seq) {
        this.detections.set(key, { seq, value: { ...entry.value, resolved: true } });
      }
    }
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  // ── ライブイベント適用 ─────────────────────────────────────────────
  /** 1 件のサーバイベントを適用する。冪等・整列・欠番検知を行う。 */
  apply(event: ServerEvent): void {
    const startedAt = performance.now();

    // 別セッションのイベントは破棄（同じ LiveKit ルームの参加者による汚染を防ぐ）。
    if (this.expectedSessionId !== null && event.session_id !== this.expectedSessionId) {
      this.metrics.recordDropped();
      return;
    }

    // ハイドレーション境界より古いライブ差分はスナップショットに含まれる → 破棄。
    if (event.seq <= this.hydrationSeq) {
      this.metrics.recordDuplicate();
      return;
    }

    // 欠番検知: 期待する次 seq を飛ばして届いたら gap。契約 §4 に従い、欠落差分を
    // GET で取り直す契機として購読者（hook）へ通知する。
    if (this.maxSeq > 0 && event.seq > this.maxSeq + 1) {
      this.metrics.recordGap();
      for (const l of this.gapListeners) l();
    }

    const applied = this.reduce(event);
    if (!applied) {
      this.metrics.recordDuplicate();
      return;
    }

    this.maxSeq = Math.max(this.maxSeq, event.seq);
    this.metrics.recordReceived();
    this.metrics.recordApplyLatency(performance.now() - startedAt);
    this.invalidate();
  }

  /** 適用したら true、（古い/重複で）スキップしたら false。 */
  private reduce(event: ServerEvent): boolean {
    switch (event.type) {
      case "status":
        // status は id を持たず upsert の seq ガードを通らない。最後に適用した
        // status seq より古いものは破棄し、phase の巻き戻しを防ぐ（lossy 可・順序は seq）。
        if (event.seq <= this.lastStatusSeq) return false;
        this.lastStatusSeq = event.seq;
        this.phase = event.phase;
        this.agentsActive = event.agents_active ?? 0;
        return true;

      case "transcript.partial":
      case "transcript.final": {
        const final = event.type === "transcript.final";
        return this.upsert(this.transcript, event.utterance_id, event.seq, {
          utterance_id: event.utterance_id,
          speaker: event.speaker,
          role: event.role,
          text: event.text,
          final,
        });
      }

      case "detection.contradiction": {
        const existing = this.detections.get(event.id);
        if (existing && existing.seq >= event.seq && existing.value.resolved) {
          // resolved が先着している場合: 詳細だけマージして resolved 状態を保持する。
          this.detections.set(event.id, {
            seq: existing.seq,
            value: {
              ...existing.value,
              kind: "contradiction",
              summary: event.summary,
              refs: event.refs,
              options: event.options,
              detector: event.detector,
            },
          });
          return true;
        }
        return this.upsert(this.detections, event.id, event.seq, {
          id: event.id,
          kind: "contradiction",
          summary: event.summary,
          refs: event.refs,
          options: event.options,
          detector: event.detector,
          resolved: false,
        });
      }

      case "detection.gap": {
        const existing = this.detections.get(event.id);
        if (existing && existing.seq >= event.seq && existing.value.resolved) {
          // resolved が先着している場合: 詳細だけマージして resolved 状態を保持する。
          this.detections.set(event.id, {
            seq: existing.seq,
            value: {
              ...existing.value,
              kind: "gap",
              summary: event.summary,
              category: event.category,
              refs: event.refs,
              detector: event.detector,
            },
          });
          return true;
        }
        return this.upsert(this.detections, event.id, event.seq, {
          id: event.id,
          kind: "gap",
          summary: event.summary,
          category: event.category,
          refs: event.refs,
          detector: event.detector,
          resolved: false,
        });
      }

      case "detection.resolved": {
        const prev = this.detections.get(event.detection_id);
        if (!prev) {
          // 対象未着でも解消だけ先に来る場合があるため、最小の解消マーカを置く。
          return this.upsert(this.detections, event.detection_id, event.seq, {
            id: event.detection_id,
            kind: "contradiction",
            summary: "",
            refs: [],
            detector: "",
            resolved: true,
            resolution: event.resolution,
            selected_value: event.selected_value,
          });
        }
        return this.upsert(this.detections, event.detection_id, event.seq, {
          ...prev.value,
          resolved: true,
          resolution: event.resolution,
          selected_value: event.selected_value ?? prev.value.selected_value,
        });
      }

      case "requirement.upserted":
        return this.upsert(
          this.requirements,
          event.requirement.id,
          event.seq,
          event.requirement,
        );

      case "question.asked":
        // 通常質問（金枠 / #181）。id を持つが「最新1問」を表示するため status/completed と
        // 同じく seq ガードで巻き戻しを防ぐ（新しい問いが古い再配信に負けない）。
        if (event.seq <= this.lastQuestionSeq) return false;
        this.lastQuestionSeq = event.seq;
        this.question = {
          id: event.id,
          prompt: event.prompt,
          options: event.options ?? [],
        };
        return true;

      case "question.cleared":
        // 現在質問のクリア伝播（#212 / ADR-0020 §5-10）。`question.asked` と対称な seq ガード。
        // 古いクリア（cleared_seq <= lastQuestionSeq）は新しい問いを畳まないよう破棄する
        // （例: q2.ask(seq=7) 適用後に遅延 q1.cleared(seq=6) が来ても 6<=7 で棄却）。
        if (event.seq <= this.lastQuestionSeq) return false;
        // 受信した事実として lastQuestionSeq を前進する（畳む/畳まないに依らず）。これで、
        // current=null のまま clear を受けた直後に古い GET が後着しても §5-2 の
        // `seq > lastQuestionSeq` を満たせず、クリア済みの問いを復活させない（§5-10）。
        this.lastQuestionSeq = event.seq;
        // 当該の問いを指すクリアのときだけピンを畳む。別の問い対象の遅延クリアで現在の問いを
        // 消さない。current=null（ask を取り逃した）でも lastQuestionSeq は進める（上で前進済み）。
        if (this.question && this.question.id === event.question_id) {
          this.question = null;
        }
        // true を返すと apply() が maxSeq を event.seq まで進める（受信済み live seq なので前進可。
        // 畳まない場合でも誤 gap 検知を防ぐ / §5-10）。
        return true;

      case "analysis.progress": {
        const prev = this.analysis.get(event.asset_id)?.value;
        return this.upsert(this.analysis, event.asset_id, event.seq, {
          asset_id: event.asset_id,
          pct: event.pct,
          stage: event.stage,
          extracted: prev?.extracted ?? [],
          conflicts: prev?.conflicts ?? [],
        });
      }

      case "analysis.visual": {
        const prev = this.analysis.get(event.asset_id)?.value;
        return this.upsert(this.analysis, event.asset_id, event.seq, {
          asset_id: event.asset_id,
          // visual = 解析完了。抽出要件/突合が確定して届くイベントなので pct を 100 に固定する
          // （#209 案A）。直前 progress が 40% でも「visual=完了」を保証し、selectMaterials の
          // done 判定（pct>=100）が確実に立つ。契約上 visual 後に 100% progress が来る保証は無い。
          pct: 100,
          stage: prev?.stage ?? "完了",
          extracted: event.extracted,
          conflicts: event.conflicts,
        });
      }

      case "session.completed":
        if (event.seq <= this.lastCompletedSeq) return false;
        this.lastCompletedSeq = event.seq;
        this.completed = {
          contradictions_resolved: event.summary.contradictions_resolved,
          gaps_found: event.summary.gaps_found,
          issues_created: event.summary.issues_created,
          artifacts: event.artifacts,
        };
        return true;
    }
  }

  /**
   * (type,id) 冪等 upsert。既存の方が新しい seq なら（再配信/順序逆転）スキップ。
   * 反映したら true。
   */
  private upsert<T>(
    map: Map<string, Versioned<T>>,
    id: string,
    seq: number,
    value: T,
  ): boolean {
    const prev = map.get(id);
    if (prev && prev.seq >= seq) return false; // 既存が同等以上に新しい → 重複/逆順
    map.set(id, { seq, value });
    return true;
  }

  // ── スナップショット構築 ───────────────────────────────────────────
  private build(): SessionState {
    return {
      phase: this.phase,
      agentsActive: this.agentsActive,
      requirements: this.sortedValues(this.requirements),
      detections: this.sortedValues(this.detections),
      transcript: this.sortedValues(this.transcript),
      analysis: this.sortedValues(this.analysis),
      question: this.question,
      completed: this.completed,
      seq: this.maxSeq,
    };
  }

  private sortedValues<T>(map: Map<string, Versioned<T>>): T[] {
    return [...map.values()].sort((a, b) => a.seq - b.seq).map((v) => v.value);
  }

  /** テスト/リセット用。 */
  clear(): void {
    this.requirements.clear();
    this.detections.clear();
    this.transcript.clear();
    this.analysis.clear();
    this.phase = "idle";
    this.agentsActive = 0;
    this.question = null;
    this.completed = null;
    this.hydrationSeq = 0;
    this.maxSeq = 0;
    this.lastStatusSeq = 0;
    this.lastCompletedSeq = 0;
    this.lastQuestionSeq = 0;
    this.metrics.reset();
    this.invalidate();
  }
}

export const emptySessionState = (): SessionState => EMPTY_STATE;
