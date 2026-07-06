// 共有 realtime イベントストア。
//
// 3つの P0 画面（05 検知 / 08 解析 / 09 要件絵巻）が共通で必要とする受信状態を
// 1か所に集約する。各画面で別々に購読層を書くと 3重複・マージ衝突するため、ここで
// 共有化する（並列化の要）。
//
// 契約（docs/reference/realtime-contract.md §2）の適用規則:
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
  /** 直近の通常質問（金枠）。新しい question.asked で置き換わる。未提示なら null。 */
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

  /**
   * GET スナップショット境界 seq（ドメイン別）。これ以下のライブ差分は当該ドメインの
   * スナップショットに含まれるため破棄する。requirements と detections は別 GET なので境界も
   * 分ける。status/transcript/analysis/session.completed/question はどの GET にも含まれない
   * （question は lastQuestionSeq で別途ガード）ため、境界では捨てず種別ガードに委ねる。
   */
  private requirementsHydrationSeq = 0;
  private detectionsHydrationSeq = 0;
  /** 観測した最大 reliable seq（欠番検知用）。lossy は前進させない。 */
  private maxSeq = 0;
  /**
   * 最後に適用した status の順序キー。新 agent は lossy_seq で順序付ける
   * （agent 側 epoch ブロックで再起動を跨いで大域単調なので、これ単独で古い status を弾ける）。
   * 旧 agent（lossy_seq 無し）は echo された reliable seq で順序付ける（後方互換）。両系統は同一
   * セッション内で混在しないため、別々のガード変数で持つ。
   */
  private lastStatusSeq = 0;
  private lastStatusLossySeq = 0;
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
   * これ以降は seq > requirementsHydrationSeq のライブ差分だけを適用する（空白・重複ゼロ）。
   */
  hydrateRequirements(items: Requirement[], seq: number): void {
    for (const r of items) {
      const prev = this.requirements.get(r.id);
      // スナップショットより新しいライブ差分が先着していたら上書きしない。
      if (prev && prev.seq > seq) continue;
      this.requirements.set(r.id, { seq, value: r });
    }
    this.requirementsHydrationSeq = Math.max(this.requirementsHydrationSeq, seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.invalidate();
  }

  /**
   * GET /questions/current の現在質問を取り込む（契約 §4 / ADR-0020 §5-2/§5-4/§5-11）。
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
    this.detectionsHydrationSeq = Math.max(this.detectionsHydrationSeq, seq);
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

    // lossy（status/transcript.partial）は reliable seq を消費せず現在値を echo するだけ（ADR-0021）。echo した seq は境界・欠番判定に使えない（0 や境界以下になり得る）ため、lossy は
    // ここでの境界/欠番判定の対象外とし、重複排除は reduce() の lossy_seq ガードに委ねる。
    const isLossy = event.reliable === false;

    // GET スナップショット境界より古い reliable 差分は破棄（スナップショットに含まれる）。境界は
    // 種別が属する GET ドメイン別。status/transcript/analysis/session.completed は
    // どの GET にも含まれず、question は専用 seq ガード（lastQuestionSeq）を持つため、ここでは
    // 捨てず reduce() の種別ガードに委ねる。これで GET 実行中〜直後に後着した非スナップショット
    // 種別（例: status・transcript.final）を hydrationSeq 境界で取りこぼさない。
    if (!isLossy && event.seq <= this.snapshotBoundary(event.type)) {
      this.metrics.recordDuplicate();
      return;
    }

    // 欠番検知・maxSeq 前進は reliable ストリームのみ（ADR-0021）。lossy が欠落しても
    // reliable seq に穴は空かないため、lossy の欠番を gap 扱いして不要な GET 再取得を誘発しない。
    if (!isLossy && this.maxSeq > 0 && event.seq > this.maxSeq + 1) {
      this.metrics.recordGap();
      for (const l of this.gapListeners) l();
    }

    const applied = this.reduce(event);
    if (!applied) {
      this.metrics.recordDuplicate();
      return;
    }

    if (!isLossy) this.maxSeq = Math.max(this.maxSeq, event.seq);
    this.metrics.recordReceived();
    this.metrics.recordApplyLatency(performance.now() - startedAt);
    this.invalidate();
  }

  /**
   * 種別が属する GET ドメインのスナップショット境界 seq（無ければ 0 = 境界なし）。
   * 境界 0 のときは `event.seq <= 0` が偽になる（seq は 1 始まり）ため実質ノーガードで、
   * 当該種別の重複排除は reduce() 内の専用 seq ガードに委ねられる。
   */
  private snapshotBoundary(type: ServerEvent["type"]): number {
    switch (type) {
      case "requirement.upserted":
        return this.requirementsHydrationSeq;
      case "detection.contradiction":
      case "detection.gap":
      case "detection.ambiguous":
      case "detection.resolved":
        return this.detectionsHydrationSeq;
      default:
        // status / transcript.* / analysis.* / session.completed / question.* は
        // requirements・detections のどちらの GET にも含まれない（question は lastQuestionSeq で
        // 別途ガード）。境界なし（0）として reduce() の種別ガードに重複排除を委ねる。
        return 0;
    }
  }

  /** 適用したら true、（古い/重複で）スキップしたら false。 */
  private reduce(event: ServerEvent): boolean {
    switch (event.type) {
      case "status": {
        // status は lossy。順序は lossy_seq 単独で持つ。lossy_seq は agent 側で
        // epoch ブロックにより**再起動を跨いで大域単調**なので、これだけで古い status を弾ける。
        // echo された reliable seq を主キーにしない: reliable seq は set_session_seq されない
        // reliable イベント（question.* 等）の後に再起動すると後退し得るため、主キーにすると
        // 再起動直後の status が `seq < lastStatusSeq` で破棄される窓が残る。
        // 旧 agent（lossy_seq 無し）は従来どおり echo seq で順序付ける（後方互換）。
        if (event.lossy_seq === undefined) {
          if (event.seq <= this.lastStatusSeq) return false;
          this.lastStatusSeq = event.seq;
        } else {
          if (event.lossy_seq <= this.lastStatusLossySeq) return false;
          this.lastStatusLossySeq = event.lossy_seq;
        }
        this.phase = event.phase;
        this.agentsActive = event.agents_active ?? 0;
        return true;
      }

      case "transcript.partial":
      case "transcript.final": {
        // final は reliable（version=seq）、partial は lossy（version=lossy_seq、無ければ seq に
        // フォールバック＝旧 agent 後方互換）。系統が違うため同系統どうしでのみ版比較し、
        // 確定（final）を partial で巻き戻さない（ADR-0021）。partial は utterance_id 単位で、
        // 再起動後は別 utterance になるため lossy_seq リセットの影響を実質受けない。
        const isFinal = event.type === "transcript.final";
        const prev = this.transcript.get(event.utterance_id);
        if (prev?.value.final && !isFinal) return false; // 確定済みを partial で上書きしない
        const version = isFinal ? event.seq : (event.lossy_seq ?? event.seq);
        if (prev && prev.value.final === isFinal && prev.seq >= version) return false;
        this.transcript.set(event.utterance_id, {
          seq: version,
          value: {
            utterance_id: event.utterance_id,
            speaker: event.speaker,
            role: event.role,
            text: event.text,
            final: isFinal,
          },
        });
        return true;
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

      case "detection.ambiguous": {
        // 不明瞭（ambiguous・ADR-0022）。矛盾でも抜けでもない第三の未解消検知。
        // gap と同様に open として確定ゲート（07）・深掘り（06）の未解消件数へ算入される。
        const existing = this.detections.get(event.id);
        if (existing && existing.seq >= event.seq && existing.value.resolved) {
          this.detections.set(event.id, {
            seq: existing.seq,
            value: {
              ...existing.value,
              kind: "ambiguous",
              summary: event.summary,
              refs: event.refs,
              detector: event.detector,
            },
          });
          return true;
        }
        return this.upsert(this.detections, event.id, event.seq, {
          id: event.id,
          kind: "ambiguous",
          summary: event.summary,
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
        // 通常質問（金枠）。id を持つが「最新1問」を表示するため status/completed と
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
        // 現在質問のクリア伝播（ADR-0020 §5-10）。`question.asked` と対称な seq ガード。
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
          // visual = 解析完了。抽出要件/突合が確定して届くイベントなので pct を 100 に固定する。
          // 直前 progress が 40% でも「visual=完了」を保証し、selectMaterials の
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
      transcript: this.sortedTranscript(),
      analysis: this.sortedValues(this.analysis),
      question: this.question,
      completed: this.completed,
      seq: this.maxSeq,
    };
  }

  private sortedValues<T>(map: Map<string, Versioned<T>>): T[] {
    return [...map.values()].sort((a, b) => a.seq - b.seq).map((v) => v.value);
  }

  /**
   * transcript は版が 2 系統（final=reliable seq / partial=lossy_seq）。生 seq で混在
   * ソートすると系統差で誤順になるため、確定（final）を seq 昇順で前に、未確定（partial＝現在進行
   * の発話）を lossy_seq 昇順で末尾に置く。これで「確定済みの会話＋末尾に進行中の一言」が出る。
   */
  private sortedTranscript(): TranscriptLine[] {
    return [...this.transcript.values()]
      .sort((a, b) => {
        if (a.value.final !== b.value.final) return a.value.final ? -1 : 1;
        return a.seq - b.seq;
      })
      .map((v) => v.value);
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
    this.requirementsHydrationSeq = 0;
    this.detectionsHydrationSeq = 0;
    this.maxSeq = 0;
    this.lastStatusSeq = 0;
    this.lastStatusLossySeq = 0;
    this.lastCompletedSeq = 0;
    this.lastQuestionSeq = 0;
    this.metrics.reset();
    this.invalidate();
  }
}

export const emptySessionState = (): SessionState => EMPTY_STATE;
