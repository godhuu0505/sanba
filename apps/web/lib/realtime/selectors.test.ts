import { describe, expect, it } from "vitest";

import {
  mergeMaterials,
  selectActiveQuestion,
  selectMaterials,
  selectMiniStatus,
} from "./selectors";
import type { MaterialItem } from "./selectors";
import type { AnalysisState, SessionState } from "./store";

// #181: 通常質問（金枠）。選択肢があるときだけ問いピンの対象にする。
describe("selectActiveQuestion", () => {
  const state = (question: SessionState["question"]): SessionState =>
    ({ question }) as SessionState;

  it("選択肢ありの質問を返す", () => {
    const q = { id: "q1", prompt: "並び順は？", options: [{ label: "関連度順", value: "rel" }] };
    expect(selectActiveQuestion(state(q))).toEqual(q);
  });

  it("選択肢なし（自由記述）は問いピン対象にしない（null）", () => {
    expect(selectActiveQuestion(state({ id: "q1", prompt: "自由に", options: [] }))).toBeNull();
  });

  it("質問未提示なら null", () => {
    expect(selectActiveQuestion(state(null))).toBeNull();
  });
});

// #184: 復元（hydrated）/投入直後（local）/ライブ（realtime）の素材行を asset_id で統合する。
describe("mergeMaterials", () => {
  const item = (over: Partial<MaterialItem>): MaterialItem => ({
    id: "a1",
    name: "a1",
    pct: 0,
    status: "analyzing",
    ...over,
  });

  it("同一 asset_id は status/pct を realtime（ライブ）優先で統合する", () => {
    const realtime = [item({ id: "a1", name: "a1", pct: 100, status: "done", extracted: 2 })];
    const hydrated = [item({ id: "a1", name: "mock.png", pct: 0, status: "analyzing" })];
    const [m] = mergeMaterials(realtime, [], hydrated);
    expect(m.status).toBe("done");
    expect(m.pct).toBe(100);
    expect(m.extracted).toBe(2);
    // 表示名は asset_id ではなく実ファイル名（hydrated）を優先する。
    expect(m.name).toBe("mock.png");
  });

  it("local（投入直後）の実ファイル名も realtime 行に引き継ぐ", () => {
    const realtime = [item({ id: "a2", name: "a2", pct: 50, status: "analyzing" })];
    const local = [item({ id: "a2", name: "diagram.png", pct: 100, status: "analyzing" })];
    const [m] = mergeMaterials(realtime, local);
    expect(m.name).toBe("diagram.png");
  });

  it("realtime に未到達の復元行（failed/動画）も残す", () => {
    const hydrated = [
      item({ id: "v1", name: "rec.mp4", status: "analyzing" }),
      item({ id: "f1", name: "broken.png（失敗）", status: "failed" }),
    ];
    const merged = mergeMaterials([], [], hydrated);
    expect(merged.map((m) => m.id)).toEqual(["v1", "f1"]);
  });

  // #219: 中断で破棄した素材は表示・件数から除く（ゾンビ行・遅延 analysis.* の復活を防ぐ）。
  it("cancelledIds の素材は除外する（遅延 realtime が来ても復活しない）", () => {
    const realtime = [
      item({ id: "a1", name: "a1", pct: 80, status: "analyzing" }),
      item({ id: "a2", name: "a2", pct: 30, status: "analyzing" }),
    ];
    const local = [item({ id: "a1", name: "mock.png", pct: 0, status: "uploading" })];
    const merged = mergeMaterials(realtime, local, [], new Set(["a1"]));
    // a1 は破棄済みなので、遅延 realtime（解析中）が来ても行は出ない。a2 のみ残る。
    expect(merged.map((m) => m.id)).toEqual(["a2"]);
  });

  it("status==='cancelled' の行も除外する（pending の破棄行）", () => {
    const local = [
      item({ id: "c1", name: "破棄.png", status: "cancelled" }),
      item({ id: "u1", name: "up.png", status: "uploading" }),
    ];
    const merged = mergeMaterials([], local, []);
    expect(merged.map((m) => m.id)).toEqual(["u1"]);
  });
});

// 参考資料タブ（05）の素材ビューモデル。analysis.progress/visual 由来の AnalysisState を
// MaterialsList が消費する MaterialItem へ寄せる純セレクタ。
// 仕様: docs/design/conversation-experience.md §3,§6 / Issue #184（GET context/files）で name/失敗状態を補完予定。
describe("selectMaterials", () => {
  const analysis = (over: Partial<AnalysisState>): AnalysisState => ({
    asset_id: "a1",
    pct: 100,
    stage: "完了",
    extracted: [],
    conflicts: [],
    ...over,
  });

  it("解析途中（pct<100）は analyzing・抽出数なし", () => {
    expect(
      selectMaterials({ analysis: [analysis({ asset_id: "a1", pct: 40, stage: "領域検出" })] }),
    ).toEqual([{ id: "a1", name: "a1", pct: 40, status: "analyzing" }]);
  });

  it("完了（pct>=100）は done・抽出要件数を件数で返す", () => {
    expect(
      selectMaterials({
        analysis: [analysis({ asset_id: "a2", pct: 100, extracted: ["x", "y", "z"] })],
      }),
    ).toEqual([{ id: "a2", name: "a2", pct: 100, status: "done", extracted: 3 }]);
  });

  it("完了でも抽出が空なら extracted は付けない", () => {
    expect(selectMaterials({ analysis: [analysis({ asset_id: "a3", extracted: [] })] })).toEqual([
      { id: "a3", name: "a3", pct: 100, status: "done" },
    ]);
  });

  it("複数素材は受信順（state.analysis の並び）を保つ", () => {
    const items = selectMaterials({
      analysis: [
        analysis({ asset_id: "a1", pct: 30 }),
        analysis({ asset_id: "a2", pct: 100, extracted: ["r"] }),
      ],
    });
    expect(items.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(items[0].status).toBe("analyzing");
    expect(items[1].status).toBe("done");
  });

  it("空なら空配列", () => {
    expect(selectMaterials({ analysis: [] })).toEqual([]);
  });
});

// ミニ状況（◆要件 N ・ ⚠未確定 N ・ 📎資料 N（解析中））の純セレクタ。
// 仕様: docs/design/conversation-experience.md §2（常時ミニ状況）。
describe("selectMiniStatus", () => {
  it("要件数・未解消検知数・素材数・解析中フラグを導出する（深掘り一覧と同じ規則）", () => {
    const s = {
      requirements: [{}, {}, {}],
      detections: [
        { resolved: false, summary: "矛盾" }, // 数える
        { resolved: true, summary: "解決済" }, // 数えない（解消済）
        { resolved: false, summary: "抜け" }, // 数える
        { resolved: false, summary: "" }, // 数えない（summary 未着＝深掘り一覧にも出ない）
      ],
      analysis: [{ pct: 62 }, { pct: 100 }],
    };
    expect(selectMiniStatus(s)).toEqual({
      requirements: 3,
      unresolved: 2,
      materials: 2,
      analyzing: true,
    });
  });

  it("解析が全完了なら analyzing=false", () => {
    expect(
      selectMiniStatus({ requirements: [], detections: [], analysis: [{ pct: 100 }] }),
    ).toEqual({ requirements: 0, unresolved: 0, materials: 1, analyzing: false });
  });

  it("空の状態は全て 0 / false", () => {
    expect(selectMiniStatus({ requirements: [], detections: [], analysis: [] })).toEqual({
      requirements: 0,
      unresolved: 0,
      materials: 0,
      analyzing: false,
    });
  });
});
