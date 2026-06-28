import { describe, expect, it } from "vitest";
import { contractEventFixture, hydrationFixture } from "./fixtures";
import { selectMaterials } from "./selectors";
import { RealtimeStore } from "./store";
import type { Requirement, ServerEvent } from "./types";

const SESSION = "s1";

function reqEvent(seq: number, id: string, over: Partial<Requirement> = {}): ServerEvent {
  return {
    v: 1,
    type: "requirement.upserted",
    seq,
    ts: "2026-06-24T00:00:00Z",
    session_id: SESSION,
    requirement: {
      id,
      statement: `req ${id} @${seq}`,
      category: "functional",
      priority: "should",
      confidence: 0.7,
      source_speaker: "PM",
      citations: [],
      status: "draft",
      ...over,
    },
  };
}

function contradiction(seq: number, id: string): ServerEvent {
  return {
    v: 1,
    type: "detection.contradiction",
    seq,
    ts: "2026-06-24T00:00:00Z",
    session_id: SESSION,
    id,
    summary: `c ${id}`,
    refs: [],
    detector: "contradiction_detector",
  };
}

describe("RealtimeStore — (type,id) upsert", () => {
  it("upserts the same requirement id instead of duplicating", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(1, "r1", { statement: "old" }));
    s.apply(reqEvent(2, "r1", { statement: "new", status: "confirmed" }));
    const reqs = s.getSnapshot().requirements;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].statement).toBe("new");
    expect(reqs[0].status).toBe("confirmed");
  });

  it("keeps distinct ids separate", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(1, "r1"));
    s.apply(reqEvent(2, "r2"));
    expect(s.getSnapshot().requirements).toHaveLength(2);
  });
});

describe("RealtimeStore — seq ordering", () => {
  it("sorts entities by seq ascending", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(3, "r3"));
    s.apply(reqEvent(1, "r1"));
    s.apply(reqEvent(2, "r2"));
    expect(s.getSnapshot().requirements.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("does not overwrite a newer entity with a re-ordered older seq", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(5, "r1", { statement: "newer" }));
    s.apply(reqEvent(2, "r1", { statement: "older" })); // 逆順で遅着
    expect(s.getSnapshot().requirements[0].statement).toBe("newer");
  });
});

describe("RealtimeStore — dedup", () => {
  it("ignores an exact re-delivery of the same seq", () => {
    const s = new RealtimeStore();
    s.apply(contradiction(1, "d1"));
    s.apply(contradiction(1, "d1")); // 再配信
    expect(s.getSnapshot().detections).toHaveLength(1);
    expect(s.metrics.read().duplicates).toBe(1);
    expect(s.metrics.read().received).toBe(1);
  });
});

function progress(seq: number, asset_id: string, pct: number, stage = "領域検出"): ServerEvent {
  return { v: 1, type: "analysis.progress", seq, ts: "2026-06-24T00:00:00Z", session_id: SESSION, asset_id, pct, stage };
}

function visual(seq: number, asset_id: string, extracted: string[]): ServerEvent {
  return { v: 1, type: "analysis.visual", seq, ts: "2026-06-24T00:00:00Z", session_id: SESSION, asset_id, extracted, conflicts: [] };
}

describe("RealtimeStore — analysis.visual = 完了 (#209 案A)", () => {
  it("progress 40% の後に visual が来たら pct を 100 に固定し、抽出/状態を完了にする", () => {
    const s = new RealtimeStore();
    s.apply(progress(1, "a1", 40, "領域検出"));
    s.apply(visual(2, "a1", ["要件X", "要件Y"]));

    const a = s.getSnapshot().analysis[0];
    expect(a.pct).toBe(100); // 直前の 40% を引きずらない
    expect(a.extracted).toEqual(["要件X", "要件Y"]); // 抽出は保持

    // AC: セレクタ越しに done + 抽出件数まで通ること。
    expect(selectMaterials(s.getSnapshot())).toEqual([
      { id: "a1", name: "a1", pct: 100, status: "done", extracted: 2 },
    ]);
  });

  it("progress 単独（visual 未着）は pct を保ち analyzing のまま（visual だけが完了を立てる）", () => {
    const s = new RealtimeStore();
    s.apply(progress(1, "a1", 40));
    const a = s.getSnapshot().analysis[0];
    expect(a.pct).toBe(40);
    expect(selectMaterials(s.getSnapshot())[0].status).toBe("analyzing");
  });

  it("visual の遅着再配信（古い seq）は seq ガードで弾く（単調性を壊さない）", () => {
    const s = new RealtimeStore();
    s.apply(progress(2, "a1", 40));
    s.apply(visual(3, "a1", ["要件X"]));
    s.apply(visual(1, "a1", [])); // 古い seq の遅着 → 無視
    const a = s.getSnapshot().analysis[0];
    expect(a.pct).toBe(100);
    expect(a.extracted).toEqual(["要件X"]); // 上書きされない
  });
});

describe("RealtimeStore — gap detection", () => {
  it("records a gap when a seq is skipped", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(1, "r1"));
    s.apply(reqEvent(4, "r4")); // 2,3 が欠番
    expect(s.metrics.read().gaps).toBe(1);
    // 欠番でも前進はする。
    expect(s.getSnapshot().requirements).toHaveLength(2);
  });
});

describe("RealtimeStore — hydration boundary", () => {
  it("discards live events at or below the hydration seq, applies above", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, hydrationFixture.seq); // seq=6
    // seq<=6 のライブ差分は破棄（スナップショットに含まれる）。
    s.apply(reqEvent(6, "r1", { statement: "stale" }));
    expect(s.getSnapshot().requirements[0].statement).not.toBe("stale");
    expect(s.metrics.read().duplicates).toBe(1);
    // seq>6 は適用。
    s.apply(reqEvent(7, "r1", { statement: "live", status: "confirmed" }));
    expect(s.getSnapshot().requirements[0].statement).toBe("live");
  });

  it("does not drop a hydrated requirement when later live diff has higher seq", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, 6);
    s.apply(reqEvent(8, "r1", { status: "confirmed" }));
    const r = s.getSnapshot().requirements.find((x) => x.id === "r1");
    expect(r?.status).toBe("confirmed");
  });
});

describe("RealtimeStore — detection lifecycle", () => {
  it("marks a detection resolved on detection.resolved", () => {
    const s = new RealtimeStore();
    s.apply(contradiction(1, "d1"));
    s.apply({
      v: 1,
      type: "detection.resolved",
      seq: 2,
      ts: "2026-06-24T00:00:00Z",
      session_id: SESSION,
      detection_id: "d1",
      resolution: "user_selected",
      selected_value: "relevance",
    });
    const d = s.getSnapshot().detections[0];
    expect(d.resolved).toBe(true);
    expect(d.selected_value).toBe("relevance");
  });
});

describe("RealtimeStore — status ordering", () => {
  it("does not roll back phase with a stale, lower-seq status", () => {
    const s = new RealtimeStore();
    s.apply({
      v: 1,
      type: "status",
      seq: 5,
      ts: "t",
      session_id: SESSION,
      phase: "deliberating",
    });
    s.apply({
      v: 1,
      type: "status",
      seq: 2,
      ts: "t",
      session_id: SESSION,
      phase: "listening",
    });
    expect(s.getSnapshot().phase).toBe("deliberating");
  });
});

describe("RealtimeStore — session isolation", () => {
  it("drops events whose session_id does not match the expected one", () => {
    const s = new RealtimeStore();
    s.setExpectedSessionId(SESSION);
    s.apply({ ...contradiction(1, "d1"), session_id: "other" });
    expect(s.getSnapshot().detections).toHaveLength(0);
    expect(s.metrics.read().dropped).toBe(1);
    // 正しいセッションのものは適用される。
    s.apply(contradiction(2, "d2"));
    expect(s.getSnapshot().detections).toHaveLength(1);
  });
});

describe("RealtimeStore — gap recovery", () => {
  it("notifies gap listeners when a seq is skipped", () => {
    const s = new RealtimeStore();
    let fired = 0;
    s.onGapDetected(() => {
      fired += 1;
    });
    s.apply(reqEvent(1, "r1"));
    s.apply(reqEvent(4, "r4")); // 2,3 欠番
    expect(fired).toBe(1);
  });
});

function questionAsked(
  seq: number,
  id: string,
  options?: { label: string; value: string }[],
): ServerEvent {
  return {
    v: 1,
    type: "question.asked",
    seq,
    ts: "2026-06-24T00:00:00Z",
    session_id: SESSION,
    id,
    prompt: `Q ${id}`,
    ...(options ? { options } : {}),
  } as ServerEvent;
}

describe("RealtimeStore — question.asked（#181）", () => {
  it("最新の質問を state.question に保持し、古い再配信で巻き戻らない", () => {
    const s = new RealtimeStore();
    s.apply(questionAsked(1, "q1", [{ label: "A", value: "a" }]));
    expect(s.getSnapshot().question?.id).toBe("q1");
    s.apply(questionAsked(3, "q2", [{ label: "B", value: "b" }]));
    expect(s.getSnapshot().question?.id).toBe("q2");
    // 古い seq の再配信（q1@2）は無視され、最新 q2 を保つ。
    s.apply(questionAsked(2, "q1", [{ label: "A", value: "a" }]));
    expect(s.getSnapshot().question?.id).toBe("q2");
  });

  it("選択肢なしの質問も保持する（options は空配列）", () => {
    const s = new RealtimeStore();
    s.apply(questionAsked(1, "q1"));
    expect(s.getSnapshot().question).toEqual({ id: "q1", prompt: "Q q1", options: [] });
  });
});

describe("RealtimeStore — fixture replay", () => {
  it("replays the contract fixture to a coherent end state", () => {
    const s = new RealtimeStore();
    for (const e of contractEventFixture) s.apply(e);
    const st = s.getSnapshot();
    expect(st.requirements).toHaveLength(3);
    expect(st.detections.find((d) => d.id === "d1")?.resolved).toBe(true);
    expect(st.analysis[0].extracted).toContain("フィルタUI");
    expect(st.completed?.issues_created).toBe(3);
    expect(st.phase).toBe("deliberating");
    // 欠番・重複は無いフィクスチャ。
    expect(s.metrics.read().gaps).toBe(0);
    expect(s.metrics.read().duplicates).toBe(0);
  });
});
