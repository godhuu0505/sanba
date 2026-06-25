import { describe, expect, it } from "vitest";

import { selectMiniStatus } from "./selectors";

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
