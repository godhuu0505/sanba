// 契約準拠のモックイベント列（Issue #101）。
//
// backend（#94 publish / #100 GET）未完でも 3画面（05/06/08/09）が UI を組めるようにする、
// フロント先行着手の鍵。realtime-contract.md §3 の各種別を網羅し、05-detection /
// 08-analysis / 09-scroll の要件票にある実例コピーをそのまま使う。
//
// seq は単調増加。重複排除・欠番検知のテストもこの列から派生させる。

import type { Requirement, ServerEvent } from "./types";

const SESSION = "demo-session";
const ts = (n: number) => new Date(2026, 5, 24, 12, 48, n % 60).toISOString();

// 共通エンベロープ（v/session_id/seq）を補完する。union に対して Omit を分配させる
// ため DistributiveOmit を使う（素の Omit は union の共通キーしか残さない）。
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function ev(
  seq: number,
  body: DistributiveOmit<ServerEvent, "v" | "session_id" | "seq">,
): ServerEvent {
  return { v: 1, session_id: SESSION, seq, ...body } as ServerEvent;
}

/**
 * 05/08/09 を一通り再現するイベント列。検索機能リニューアルの壁打ちを題材にする
 * （09-scroll.md「検索機能リニューアル · 確定12 · 検知6」のミニ版）。
 */
export const contractEventFixture: ServerEvent[] = [
  ev(1, { type: "status", ts: ts(1), phase: "listening" }),
  ev(2, {
    type: "transcript.final",
    ts: ts(2),
    speaker: "顧客",
    role: "customer",
    utterance_id: "u1",
    text: "検索結果は関連度順で出したい。",
  }),
  ev(3, {
    type: "transcript.final",
    ts: ts(3),
    speaker: "PM",
    role: "pm",
    utterance_id: "u2",
    text: "さっきは新着順と言っていた気がします。",
  }),
  ev(4, { type: "status", ts: ts(4), phase: "deliberating", agents_active: 2 }),
  // 矛盾検知（05 のボトムシート + 選択肢）。
  ev(5, {
    type: "detection.contradiction",
    ts: ts(5),
    id: "d1",
    summary: "『関連度順』と『新着順』の両説あり。どちらを基準にしますか？",
    refs: ["u1", "u2"],
    options: [
      { label: "関連度順にする", value: "relevance" },
      { label: "新着順にする", value: "recency" },
    ],
    detector: "contradiction_detector",
  }),
  // 抜け検知（05/08 の黄土）。
  ev(6, {
    type: "detection.gap",
    ts: ts(6),
    id: "d2",
    summary: "『該当なし』の空状態が未定義です。",
    category: "scope",
    refs: ["u1"],
    detector: "scope_specialist",
  }),
  // 要件が確定し始める（08/09）。
  ev(7, {
    type: "requirement.upserted",
    ts: ts(7),
    requirement: requirement("r1", {
      statement: "キーワード検索を新設し、結果を既定で関連度順に並べる。",
      category: "functional",
      priority: "must",
      confidence: 0.86,
      source_speaker: "顧客",
      citations: [{ kind: "utterance", ref: "u1" }],
      status: "confirmed",
    }),
  }),
  // 素材アップロード → 解析の進捗（07/08）。
  ev(8, {
    type: "analysis.progress",
    ts: ts(8),
    asset_id: "a1",
    pct: 40,
    stage: "領域検出",
  }),
  ev(9, {
    type: "analysis.progress",
    ts: ts(9),
    asset_id: "a1",
    pct: 80,
    stage: "OCR",
  }),
  // 言葉×画の矛盾（08）。
  ev(10, {
    type: "analysis.visual",
    ts: ts(10),
    asset_id: "a1",
    extracted: ["3カラム一覧", "フィルタUI", "削除導線"],
    conflicts: [
      {
        summary: "画面に検索バーが無いが『検索したい』と発言 → 検索バー新設を起票",
        refs: ["u1"],
      },
    ],
  }),
  // ユーザーが選択肢をタップ → agent 側で解消され resolved が返る（05 の往復）。
  ev(11, {
    type: "detection.resolved",
    ts: ts(11),
    detection_id: "d1",
    resolution: "user_selected",
    selected_value: "relevance",
  }),
  // 解消メモが要件として確定（09 の「解消」タグ相当）。
  ev(12, {
    type: "requirement.upserted",
    ts: ts(12),
    requirement: requirement("r2", {
      statement: "並び順は関連度順を既定とし、新着順へ切り替え可能にする。",
      category: "constraint",
      priority: "should",
      confidence: 0.9,
      source_speaker: "インタビュー統括",
      citations: [{ kind: "utterance", ref: "u2" }],
      status: "confirmed",
    }),
  }),
  ev(13, {
    type: "requirement.upserted",
    ts: ts(13),
    requirement: requirement("r3", {
      statement: "『該当なし』の空状態を設計する。",
      category: "scope",
      priority: "should",
      confidence: 0.72,
      source_speaker: "scope_specialist",
      citations: [{ kind: "utterance", ref: "u1" }],
      status: "draft",
    }),
  }),
  ev(14, {
    type: "session.completed",
    ts: ts(14),
    summary: { contradictions_resolved: 1, gaps_found: 1, issues_created: 3 },
    artifacts: [{ kind: "issue", url: "https://github.com/godhuu0505/sanba/issues/999" }],
  }),
];

function requirement(
  id: string,
  rest: Omit<Requirement, "id">,
): Requirement {
  return { id, ...rest };
}

/** ハイドレーション（GET /requirements）のモック。seq=6 までを反映済みとする。 */
export const hydrationFixture: { items: Requirement[]; seq: number } = {
  seq: 6,
  items: [
    requirement("r1", {
      statement: "キーワード検索を新設し、結果を既定で関連度順に並べる。",
      category: "functional",
      priority: "must",
      confidence: 0.8,
      source_speaker: "顧客",
      citations: [{ kind: "utterance", ref: "u1" }],
      status: "draft",
    }),
  ],
};
