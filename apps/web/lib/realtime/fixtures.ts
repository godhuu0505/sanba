
import type { Requirement, ServerEvent } from "./types";

const SESSION = "demo-session";
const ts = (n: number) => new Date(2026, 5, 24, 12, 48, n % 60).toISOString();

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function ev(
  seq: number,
  body: DistributiveOmit<ServerEvent, "v" | "session_id" | "seq">,
): ServerEvent {
  return { v: 1, session_id: SESSION, seq, ...body } as ServerEvent;
}

export const contractEventFixture: ServerEvent[] = [
  ev(0, { type: "status", ts: ts(1), phase: "listening", reliable: false, lossy_seq: 1 }),
  ev(1, {
    type: "transcript.final",
    ts: ts(2),
    speaker: "顧客",
    role: "customer",
    utterance_id: "u1",
    text: "検索結果は関連度順で出したい。",
  }),
  ev(2, {
    type: "transcript.final",
    ts: ts(3),
    speaker: "PM",
    role: "pm",
    utterance_id: "u2",
    text: "さっきは新着順と言っていた気がします。",
  }),
  ev(2, {
    type: "status",
    ts: ts(4),
    phase: "deliberating",
    agents_active: 2,
    reliable: false,
    lossy_seq: 2,
  }),
  ev(3, {
    type: "inquiry.node",
    ts: ts(5),
    op: "upsert",
    node: {
      id: "nq-c1",
      parent_id: null,
      kind: "contradiction",
      text: "『関連度順』と『新着順』の両説あり。どちらを基準にしますか？",
      status: "open",
      confidence: 0.8,
      depth: 0,
      origin: "conversation",
      refs: ["u1", "u2"],
      created_seq: 3,
      resolved_seq: null,
    },
  }),
  ev(4, {
    type: "inquiry.node",
    ts: ts(6),
    op: "upsert",
    node: {
      id: "nq-g1",
      parent_id: null,
      kind: "gap",
      text: "『該当なし』の空状態が未定義です。",
      status: "open",
      confidence: 0.72,
      depth: 0,
      origin: "analysis",
      refs: ["u1"],
      created_seq: 4,
      resolved_seq: null,
    },
  }),
  ev(5, {
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
  ev(6, {
    type: "analysis.progress",
    ts: ts(8),
    asset_id: "a1",
    pct: 40,
    stage: "領域検出",
  }),
  ev(7, {
    type: "analysis.progress",
    ts: ts(9),
    asset_id: "a1",
    pct: 80,
    stage: "OCR",
  }),
  ev(8, {
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
  ev(9, {
    type: "inquiry.node",
    ts: ts(11),
    op: "resolve",
    node: {
      id: "nq-c1",
      parent_id: null,
      kind: "contradiction",
      text: "『関連度順』と『新着順』の両説あり。どちらを基準にしますか？",
      status: "resolved",
      confidence: 0.8,
      depth: 0,
      origin: "conversation",
      refs: ["u1", "u2"],
      created_seq: 3,
      resolved_seq: 9,
    },
  }),
  ev(10, {
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
  ev(11, {
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
  ev(12, {
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
