import { describe, expect, it } from "vitest";

import { selectMaterials, selectMiniStatus } from "./selectors";
import type { AnalysisState } from "./store";

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
