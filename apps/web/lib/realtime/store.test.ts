import { describe, expect, it } from "vitest";
import { contractEventFixture, hydrationFixture } from "./fixtures";
import { selectMaterials } from "./selectors";
import { RealtimeStore, emptySessionState } from "./store";
import type { InquiryNode, Requirement, ServerEvent } from "./types";

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

function inquiryNode(over: Partial<InquiryNode> & { id: string }): InquiryNode {
  return {
    parent_id: null,
    kind: "gap",
    text: "確認事項",
    status: "open",
    confidence: 0.6,
    depth: 0,
    origin: "conversation",
    refs: [],
    created_seq: 0,
    resolved_seq: null,
    ...over,
  };
}

function inquiryEvent(seq: number, op: "upsert" | "resolve" | "drop", node: InquiryNode): ServerEvent {
  return {
    v: 1,
    type: "inquiry.node",
    seq,
    ts: "2026-06-24T00:00:00Z",
    session_id: SESSION,
    op,
    node,
  };
}

function contradiction(seq: number, id: string): ServerEvent {
  return inquiryEvent(
    seq,
    "upsert",
    inquiryNode({ id, kind: "contradiction", text: `c ${id}`, created_seq: seq }),
  );
}

function ambiguous(seq: number, id: string): ServerEvent {
  return inquiryEvent(
    seq,
    "upsert",
    inquiryNode({ id, kind: "ambiguous", text: `a ${id}`, created_seq: seq }),
  );
}

describe("RealtimeStore — inquiry.node upsert/resolve/drop", () => {
  it("upsert で kind=ambiguous の open ノードを取り込む", () => {
    const s = new RealtimeStore();
    s.apply(ambiguous(1, "a1"));
    const nodes = s.getSnapshot().inquiryNodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("ambiguous");
    expect(nodes[0].status).toBe("open");
  });

  it("upsert はノード全体を置換する（新しい seq が勝つ）", () => {
    const s = new RealtimeStore();
    s.apply(inquiryEvent(1, "upsert", inquiryNode({ id: "n1", text: "旧", created_seq: 1 })));
    s.apply(inquiryEvent(2, "upsert", inquiryNode({ id: "n1", text: "新", created_seq: 1 })));
    const nodes = s.getSnapshot().inquiryNodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("新");
  });

  it("resolve は status を resolved に更新する", () => {
    const s = new RealtimeStore();
    s.apply(inquiryEvent(1, "upsert", inquiryNode({ id: "n1", kind: "gap", created_seq: 1 })));
    s.apply(
      inquiryEvent(2, "resolve", inquiryNode({ id: "n1", kind: "gap", created_seq: 1, resolved_seq: 2 })),
    );
    const n = s.getSnapshot().inquiryNodes[0];
    expect(n.status).toBe("resolved");
    expect(n.resolved_seq).toBe(2);
  });

  it("drop は status を dropped に更新する", () => {
    const s = new RealtimeStore();
    s.apply(inquiryEvent(1, "upsert", inquiryNode({ id: "n1", created_seq: 1 })));
    s.apply(inquiryEvent(2, "drop", inquiryNode({ id: "n1", created_seq: 1 })));
    expect(s.getSnapshot().inquiryNodes[0].status).toBe("dropped");
  });

  it("既知イベントとして applied=true を返し maxSeq を進める（未知扱いの誤 gap を出さない）", () => {
    const s = new RealtimeStore();
    s.apply(inquiryEvent(1, "upsert", inquiryNode({ id: "n1", created_seq: 1 })));
    s.apply(inquiryEvent(2, "upsert", inquiryNode({ id: "n2", created_seq: 2 })));
    expect(s.getSnapshot().seq).toBe(2);
    expect(s.metrics.read().gaps).toBe(0);
  });

  it("created_seq 昇順でノードを並べる（更新後も並びが崩れない）", () => {
    const s = new RealtimeStore();
    s.apply(inquiryEvent(1, "upsert", inquiryNode({ id: "n1", text: "一", created_seq: 1 })));
    s.apply(inquiryEvent(2, "upsert", inquiryNode({ id: "n2", text: "二", created_seq: 2 })));
    s.apply(inquiryEvent(3, "resolve", inquiryNode({ id: "n1", text: "一", created_seq: 1, resolved_seq: 3 })));
    expect(s.getSnapshot().inquiryNodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

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
    s.apply(reqEvent(2, "r1", { statement: "older" }));
    expect(s.getSnapshot().requirements[0].statement).toBe("newer");
  });
});

describe("RealtimeStore — dedup", () => {
  it("ignores an exact re-delivery of the same seq", () => {
    const s = new RealtimeStore();
    s.apply(contradiction(1, "d1"));
    s.apply(contradiction(1, "d1"));
    expect(s.getSnapshot().inquiryNodes).toHaveLength(1);
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
    expect(a.pct).toBe(100);
    expect(a.extracted).toEqual(["要件X", "要件Y"]);

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
    s.apply(visual(1, "a1", []));
    const a = s.getSnapshot().analysis[0];
    expect(a.pct).toBe(100);
    expect(a.extracted).toEqual(["要件X"]);
  });
});

describe("RealtimeStore — hydrateAnalysis（#355 再接続時の解析詳細復元）", () => {
  it("done 素材の観察テキストを seq 0 で seed し、詳細セレクタが復元できる", () => {
    const s = new RealtimeStore();
    s.hydrateAnalysis([
      { id: "a1", status: "done", extracted_texts: ["要件X", "要件Y"] },
      { id: "a2", status: "failed" },
      { id: "a3", status: "analyzing" },
    ]);
    const snap = s.getSnapshot();
    expect(snap.analysis).toHaveLength(2);
    const a1 = snap.analysis.find((a) => a.asset_id === "a1");
    expect(a1?.pct).toBe(100);
    expect(a1?.extracted).toEqual(["要件X", "要件Y"]);
    const a2 = snap.analysis.find((a) => a.asset_id === "a2");
    expect(a2?.stage).toBe("failed");
  });

  it("ライブイベント既着の素材は上書きしない（ライブが常に新しい）", () => {
    const s = new RealtimeStore();
    s.apply(visual(3, "a1", ["ライブの要件"]));
    s.hydrateAnalysis([{ id: "a1", status: "done", extracted_texts: ["古い要件"] }]);
    expect(s.getSnapshot().analysis[0].extracted).toEqual(["ライブの要件"]);
  });

  it("seed 後に届くライブイベント（seq > 0）は seed を上書きする", () => {
    const s = new RealtimeStore();
    s.hydrateAnalysis([{ id: "a1", status: "done", extracted_texts: ["古い要件"] }]);
    s.apply(visual(1, "a1", ["新しい要件"]));
    expect(s.getSnapshot().analysis[0].extracted).toEqual(["新しい要件"]);
  });
});

function contextProgress(
  seq: number,
  source: "prep" | "repo",
  stage: string,
  label = "",
  detail = "",
): ServerEvent {
  return {
    v: 1,
    type: "context.progress",
    seq,
    ts: "2026-06-24T00:00:00Z",
    session_id: SESSION,
    source,
    stage,
    label,
    detail,
  } as ServerEvent;
}

describe("RealtimeStore — context.progress（P1-a 前提読み込み）", () => {
  it("prep/repo を source ごとに 1 行として保持し、後続イベントで上書きする", () => {
    const s = new RealtimeStore();
    s.apply(contextProgress(1, "prep", "done", "ゴールとゴール詳細"));
    s.apply(contextProgress(2, "repo", "running", "octo/app@main"));
    s.apply(contextProgress(3, "repo", "reused", "octo/app@main", "索引済みを利用"));

    const cp = s.getSnapshot().contextProgress;
    expect(cp).toHaveLength(2);
    const repo = cp.find((c) => c.source === "repo");
    expect(repo?.stage).toBe("reused");
    expect(repo?.detail).toBe("索引済みを利用");
  });

  it("古い seq の再配信は単調性ガードで弾く", () => {
    const s = new RealtimeStore();
    s.apply(contextProgress(3, "repo", "reused", "octo/app@main"));
    s.apply(contextProgress(1, "repo", "running", "octo/app@main"));
    expect(s.getSnapshot().contextProgress[0].stage).toBe("reused");
  });
});

describe("RealtimeStore — session.end_proposed（P1-b）", () => {
  function endProposed(seq: number, open: number, reqs: number, mats: number): ServerEvent {
    return {
      v: 1,
      type: "session.end_proposed",
      seq,
      ts: "2026-06-24T00:00:00Z",
      session_id: SESSION,
      open_count: open,
      requirement_count: reqs,
      material_count: mats,
    } as ServerEvent;
  }

  it("終了提案を保持し、新しい seq で上書きする", () => {
    const s = new RealtimeStore();
    s.apply(endProposed(1, 0, 3, 1));
    expect(s.getSnapshot().endProposal).toEqual({
      open_count: 0,
      requirement_count: 3,
      material_count: 1,
    });
    s.apply(endProposed(2, 0, 5, 2));
    expect(s.getSnapshot().endProposal?.requirement_count).toBe(5);
  });

  it("古い seq の再配信は弾く", () => {
    const s = new RealtimeStore();
    s.apply(endProposed(3, 0, 5, 0));
    s.apply(endProposed(1, 0, 1, 0));
    expect(s.getSnapshot().endProposal?.requirement_count).toBe(5);
  });
});

describe("RealtimeStore — gap detection", () => {
  it("records a gap when a seq is skipped", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(1, "r1"));
    s.apply(reqEvent(4, "r4"));
    expect(s.metrics.read().gaps).toBe(1);
    expect(s.getSnapshot().requirements).toHaveLength(2);
  });
});

describe("RealtimeStore — hydration boundary", () => {
  it("discards live events at or below the hydration seq, applies above", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, hydrationFixture.seq);
    s.apply(reqEvent(6, "r1", { statement: "stale" }));
    expect(s.getSnapshot().requirements[0].statement).not.toBe("stale");
    expect(s.metrics.read().duplicates).toBe(1);
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

  it("applies non-snapshot events (status) that arrive at/below the requirements boundary", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, 6);
    s.apply({
      v: 1,
      type: "status",
      seq: 4,
      ts: "t",
      session_id: SESSION,
      phase: "deliberating",
      reliable: false,
      lossy_seq: 1,
    });
    expect(s.getSnapshot().phase).toBe("deliberating");
    expect(s.metrics.read().duplicates).toBe(0);
  });

  it("applies a late transcript.final below the requirements boundary (not in any GET)", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, 6);
    s.apply({
      v: 1,
      type: "transcript.final",
      seq: 3,
      ts: "t",
      session_id: SESSION,
      utterance_id: "u1",
      speaker: "PM",
      role: "participant",
      text: "発話",
    });
    expect(s.getSnapshot().transcript).toHaveLength(1);
  });

  it("does not drop an inquiry node by the requirements boundary when inquiry was not hydrated", () => {
    const s = new RealtimeStore();
    s.hydrateRequirements(hydrationFixture.items, 6);
    s.apply(contradiction(2, "d1"));
    expect(s.getSnapshot().inquiryNodes).toHaveLength(1);
    expect(s.metrics.read().duplicates).toBe(0);
  });

  it("drops a live inquiry node at/below its own inquiry boundary after hydrateInquiry", () => {
    const s = new RealtimeStore();
    s.hydrateInquiry([inquiryNode({ id: "d1", kind: "gap", text: "snap", created_seq: 6 })], 6);
    s.apply(contradiction(5, "d1"));
    expect(s.metrics.read().duplicates).toBe(1);
    s.apply(contradiction(7, "d2"));
    expect(s.getSnapshot().inquiryNodes.find((n) => n.id === "d2")).toBeTruthy();
  });
});

describe("RealtimeStore — inquiry lifecycle", () => {
  it("marks a node resolved on op=resolve", () => {
    const s = new RealtimeStore();
    s.apply(contradiction(1, "d1"));
    s.apply(
      inquiryEvent(
        2,
        "resolve",
        inquiryNode({ id: "d1", kind: "contradiction", text: "c d1", created_seq: 1, resolved_seq: 2 }),
      ),
    );
    const n = s.getSnapshot().inquiryNodes[0];
    expect(n.status).toBe("resolved");
    expect(n.resolved_seq).toBe(2);
  });
});

describe("RealtimeStore — status ordering", () => {
  const status = (echoSeq: number, lossySeq: number, phase: string) => ({
    v: 1,
    type: "status" as const,
    seq: echoSeq,
    ts: "t",
    session_id: SESSION,
    phase: phase as "deliberating" | "listening",
    reliable: false,
    lossy_seq: lossySeq,
  });

  it("does not roll back phase with a stale, lower lossy_seq status (同一 echoSeq)", () => {
    const s = new RealtimeStore();
    s.apply(status(0, 5, "deliberating"));
    s.apply(status(0, 2, "listening"));
    expect(s.getSnapshot().phase).toBe("deliberating");
  });

  it("再起動後も lossy_seq の epoch ブロックで status が復帰する", () => {
    const s = new RealtimeStore();
    s.apply(status(3, 9, "listening"));
    s.apply(status(2, 1_000_000_001, "deliberating"));
    expect(s.getSnapshot().phase).toBe("deliberating");
  });

  it("旧 agent（lossy_seq 無し）は seq で順序付く（後方互換 / Codex P2）", () => {
    const s = new RealtimeStore();
    s.apply({ v: 1, type: "status", seq: 1, ts: "t", session_id: SESSION, phase: "listening" });
    s.apply({ v: 1, type: "status", seq: 2, ts: "t", session_id: SESSION, phase: "deliberating" });
    expect(s.getSnapshot().phase).toBe("deliberating");
  });

  it("does not record a gap or advance maxSeq for lossy status events (#122)", () => {
    const s = new RealtimeStore();
    s.apply(reqEvent(1, "r1"));
    s.apply(status(1, 1, "deliberating"));
    s.apply(status(1, 3, "listening"));
    s.apply(reqEvent(2, "r2"));
    expect(s.metrics.read().gaps).toBe(0);
    expect(s.getSnapshot().seq).toBe(2);
  });
});

describe("RealtimeStore — transcript partial/final（#122）", () => {
  const partial = (lossySeq: number, id: string, text: string) =>
    ({
      v: 1,
      type: "transcript.partial" as const,
      seq: 0,
      ts: "t",
      session_id: SESSION,
      utterance_id: id,
      speaker: "顧客",
      role: "customer",
      text,
      reliable: false,
      lossy_seq: lossySeq,
    });
  const final = (seq: number, id: string, text: string) =>
    ({
      v: 1,
      type: "transcript.final" as const,
      seq,
      ts: "t",
      session_id: SESSION,
      utterance_id: id,
      speaker: "顧客",
      role: "customer",
      text,
    });

  it("partial は lossy_seq で更新され、final が確定すると partial を上書きする", () => {
    const s = new RealtimeStore();
    s.apply(partial(1, "u1", "けんさ"));
    s.apply(partial(2, "u1", "検索した"));
    expect(s.getSnapshot().transcript[0].text).toBe("検索した");
    s.apply(final(1, "u1", "検索したい"));
    const line = s.getSnapshot().transcript[0];
    expect(line.text).toBe("検索したい");
    expect(line.final).toBe(true);
  });

  it("確定（final）は遅着 partial で巻き戻らない", () => {
    const s = new RealtimeStore();
    s.apply(final(1, "u1", "検索したい"));
    s.apply(partial(9, "u1", "けんさく…"));
    const line = s.getSnapshot().transcript[0];
    expect(line.text).toBe("検索したい");
    expect(line.final).toBe(true);
  });

  it("確定は seq 昇順で前、進行中の partial は末尾に並ぶ", () => {
    const s = new RealtimeStore();
    s.apply(final(1, "u1", "一"));
    s.apply(final(2, "u2", "二"));
    s.apply(partial(1, "u3", "さん…"));
    expect(s.getSnapshot().transcript.map((t) => t.utterance_id)).toEqual(["u1", "u2", "u3"]);
  });
});

describe("RealtimeStore — session isolation", () => {
  it("drops events whose session_id does not match the expected one", () => {
    const s = new RealtimeStore();
    s.setExpectedSessionId(SESSION);
    s.apply({ ...contradiction(1, "d1"), session_id: "other" });
    expect(s.getSnapshot().inquiryNodes).toHaveLength(0);
    expect(s.metrics.read().dropped).toBe(1);
    s.apply(contradiction(2, "d2"));
    expect(s.getSnapshot().inquiryNodes).toHaveLength(1);
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
    s.apply(reqEvent(4, "r4"));
    expect(fired).toBe(1);
  });
});


describe("RealtimeStore — fixture replay", () => {
  it("replays the contract fixture to a coherent end state", () => {
    const s = new RealtimeStore();
    for (const e of contractEventFixture) s.apply(e);
    const st = s.getSnapshot();
    expect(st.requirements).toHaveLength(3);
    expect(st.inquiryNodes.find((n) => n.id === "nq-c1")?.status).toBe("resolved");
    expect(st.inquiryNodes.find((n) => n.id === "nq-g1")?.status).toBe("open");
    expect(st.analysis[0].extracted).toContain("フィルタUI");
    expect(st.completed?.issues_created).toBe(3);
    expect(st.phase).toBe("deliberating");
    expect(s.metrics.read().gaps).toBe(0);
    expect(s.metrics.read().duplicates).toBe(0);
  });
});

describe("emptySessionState — defensive copy", () => {
  it("returns a fresh object with fresh arrays on each call", () => {
    const a = emptySessionState();
    const b = emptySessionState();
    expect(a).not.toBe(b);
    expect(a.requirements).not.toBe(b.requirements);
    expect(a.inquiryNodes).not.toBe(b.inquiryNodes);
    expect(a.transcript).not.toBe(b.transcript);
    expect(a.analysis).not.toBe(b.analysis);
    expect(a.contextProgress).not.toBe(b.contextProgress);
  });

  it("does not leak mutations of a returned value into later calls", () => {
    const first = emptySessionState();
    first.requirements.push({} as never);
    first.phase = "deliberating";
    const second = emptySessionState();
    expect(second.requirements).toHaveLength(0);
    expect(second.phase).toBe("idle");
  });
});

