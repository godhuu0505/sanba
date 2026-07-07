import { describe, expect, it } from "vitest";

import {
  mergeMaterials,
  selectActiveQuestion,
  selectMaterialDetail,
  selectMaterials,
  selectMiniStatus,
} from "./selectors";
import type { MaterialItem } from "./selectors";
import type { AnalysisState, SessionState } from "./store";

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

  it("cancelledIds の素材は除外する（遅延 realtime が来ても復活しない）", () => {
    const realtime = [
      item({ id: "a1", name: "a1", pct: 80, status: "analyzing" }),
      item({ id: "a2", name: "a2", pct: 30, status: "analyzing" }),
    ];
    const local = [item({ id: "a1", name: "mock.png", pct: 0, status: "uploading" })];
    const merged = mergeMaterials(realtime, local, [], new Set(["a1"]));
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

  it("cancelled 行は同 id の realtime 後勝ちでも復活しない（cancelledIds 未指定）", () => {
    const local = [item({ id: "a1", name: "破棄.png", status: "cancelled" })];
    const realtime = [item({ id: "a1", name: "a1", pct: 60, status: "analyzing" })];
    expect(mergeMaterials(realtime, local, [])).toEqual([]);
  });
});

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

  it("stage='failed' は pct=100 でも failed（done と誤判定しない）", () => {
    expect(
      selectMaterials({ analysis: [analysis({ asset_id: "a4", pct: 100, stage: "failed" })] }),
    ).toEqual([{ id: "a4", name: "a4", pct: 100, status: "failed" }]);
  });

  it("stage='received' は解析中（受領直後・pct=10）", () => {
    expect(
      selectMaterials({ analysis: [analysis({ asset_id: "a5", pct: 10, stage: "received" })] }),
    ).toEqual([{ id: "a5", name: "a5", pct: 10, status: "analyzing" }]);
  });
});

describe("selectMaterialDetail", () => {
  const analysis = (over: Partial<AnalysisState>): AnalysisState => ({
    asset_id: "a1",
    pct: 100,
    stage: "完了",
    extracted: [],
    conflicts: [],
    ...over,
  });

  it("抽出要件の中身と言葉×画の矛盾を含めて返す", () => {
    const detail = selectMaterialDetail(
      {
        analysis: [
          analysis({
            asset_id: "a1",
            extracted: ["3カラム一覧", "フィルタUI"],
            conflicts: [{ summary: "検索バーが無いが『検索したい』と発言", refs: ["u1"] }],
          }),
        ],
      },
      "a1",
    );
    expect(detail).toEqual({
      id: "a1",
      name: "a1",
      pct: 100,
      status: "done",
      extracted: ["3カラム一覧", "フィルタUI"],
      conflicts: [{ summary: "検索バーが無いが『検索したい』と発言", refs: ["u1"] }],
      analysisReady: true,
    });
  });

  it("detection が無くても analysis.visual の矛盾を surface する（視覚解析のみの矛盾・#202 AC）", () => {
    const detail = selectMaterialDetail(
      {
        analysis: [
          analysis({
            asset_id: "a9",
            conflicts: [{ summary: "図にだけ存在する導線（言及なし）", refs: [] }],
          }),
        ],
      },
      "a9",
    );
    expect(detail?.conflicts).toEqual([{ summary: "図にだけ存在する導線（言及なし）", refs: [] }]);
  });

  it("解析途中（pct<100）は analyzing として返す", () => {
    const detail = selectMaterialDetail(
      { analysis: [analysis({ asset_id: "a2", pct: 40, stage: "領域検出" })] },
      "a2",
    );
    expect(detail?.status).toBe("analyzing");
    expect(detail?.pct).toBe(40);
    expect(detail?.analysisReady).toBe(false);
  });

  it("該当 asset_id の解析状態が無ければ null", () => {
    expect(selectMaterialDetail({ analysis: [analysis({ asset_id: "a1" })] }, "missing")).toBeNull();
    expect(selectMaterialDetail({ analysis: [] }, "a1")).toBeNull();
  });

  it("stage='failed' は failed・analysisReady=false（抽出/矛盾を確定値としない）", () => {
    const detail = selectMaterialDetail(
      { analysis: [analysis({ asset_id: "a7", pct: 100, stage: "failed" })] },
      "a7",
    );
    expect(detail?.status).toBe("failed");
    expect(detail?.analysisReady).toBe(false);
  });
});

describe("selectMiniStatus", () => {
  it("要件数・未解消検知数・素材数・解析中フラグを導出する（深掘り一覧と同じ規則）", () => {
    const s = {
      requirements: [{}, {}, {}],
      detections: [
        { resolved: false, summary: "矛盾" },
        { resolved: true, summary: "解決済" },
        { resolved: false, summary: "抜け" },
        { resolved: false, summary: "" },
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
