import { describe, expect, it } from "vitest";
import { contractEventFixture, hydrationFixture } from "./fixtures";
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

describe("RealtimeStore — lossy gap does not trigger re-hydration", () => {
  it("counts the gap but does not fire listeners for a lossy status gap", () => {
    const s = new RealtimeStore();
    let fired = 0;
    s.onGapDetected(() => {
      fired += 1;
    });
    s.apply(reqEvent(1, "r1"));
    s.apply({ v: 1, type: "status", seq: 3, ts: "t", session_id: SESSION, phase: "listening" });
    expect(s.metrics.read().gaps).toBe(1);
    expect(fired).toBe(0);
  });
});

describe("RealtimeStore — session.completed ordering", () => {
  it("does not roll back a newer completed with a stale one", () => {
    const s = new RealtimeStore();
    const completed = (seq: number, issues: number): ServerEvent => ({
      v: 1,
      type: "session.completed",
      seq,
      ts: "t",
      session_id: SESSION,
      summary: { contradictions_resolved: 0, gaps_found: 0, issues_created: issues },
      artifacts: [],
    });
    s.apply(completed(5, 6));
    s.apply(completed(2, 1));
    expect(s.getSnapshot().completed?.issues_created).toBe(6);
  });
});

describe("RealtimeStore — open snapshot authority", () => {
  it("resolves an existing open detection absent from the open snapshot", () => {
    const s = new RealtimeStore();
    s.apply(contradiction(1, "d1"));
    s.hydrateDetections([], 3);
    expect(s.getSnapshot().detections[0].resolved).toBe(true);
  });
});

describe("RealtimeStore — resolved-before-detection merge", () => {
  it("merges later creation details into an earlier resolved placeholder", () => {
    const s = new RealtimeStore();
    s.apply({
      v: 1,
      type: "detection.resolved",
      seq: 5,
      ts: "t",
      session_id: SESSION,
      detection_id: "d1",
      resolution: "user_selected",
    });
    s.apply({
      v: 1,
      type: "detection.gap",
      seq: 2,
      ts: "t",
      session_id: SESSION,
      id: "d1",
      summary: "抜けの本文",
      category: "scope",
      refs: ["u1"],
      detector: "scope_specialist",
    });
    const d = s.getSnapshot().detections[0];
    expect(d.kind).toBe("gap");
    expect(d.summary).toBe("抜けの本文");
    expect(d.resolved).toBe(true);
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
