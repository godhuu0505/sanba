import { describe, expect, it } from "vitest";
import {
  decodeServerEvent,
  encodeUserInquiryDrop,
  encodeUserInterrupt,
  encodeUserMicMode,
  encodeUserSelection,
  encodeUserText,
  encodeUserTurnCommit,
  encodeUserTurnStart,
} from "./parse";

function bytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("decodeServerEvent", () => {
  it("accepts a well-formed envelope", () => {
    const { event, reason } = decodeServerEvent(
      bytes({
        v: 1,
        type: "status",
        seq: 1,
        ts: "2026-06-24T00:00:00Z",
        session_id: "s1",
        phase: "listening",
      }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("status");
  });

  it("rejects non-JSON", () => {
    expect(decodeServerEvent(new TextEncoder().encode("not json")).reason).toBe("not-json");
  });

  it("rejects a missing envelope field", () => {
    const { reason } = decodeServerEvent(bytes({ type: "status", seq: 1 }));
    expect(reason).toBe("bad-envelope");
  });

  it("rejects an unknown event type", () => {
    const { reason } = decodeServerEvent(
      bytes({ v: 1, type: "mystery", seq: 1, ts: "t", session_id: "s1" }),
    );
    expect(reason).toBe("unknown-type");
  });

  it("rejects a schema version mismatch", () => {
    const { reason } = decodeServerEvent(
      bytes({ v: 2, type: "status", seq: 1, ts: "t", session_id: "s1" }),
    );
    expect(reason).toBe("version");
  });

  it("rejects a known type with a missing required payload field", () => {
    const { reason } = decodeServerEvent(
      bytes({ v: 1, type: "requirement.upserted", seq: 1, ts: "t", session_id: "s1" }),
    );
    expect(reason).toBe("bad-payload");
  });

  it("rejects a requirement.upserted whose nested requirement is incomplete", () => {
    const { reason } = decodeServerEvent(
      bytes({
        v: 1,
        type: "requirement.upserted",
        seq: 1,
        ts: "t",
        session_id: "s1",
        requirement: { id: "r1" },
      }),
    );
    expect(reason).toBe("bad-payload");
  });

  it("decodes a string payload too", () => {
    const json = JSON.stringify({
      v: 1,
      type: "status",
      seq: 1,
      ts: "t",
      session_id: "s1",
      phase: "idle",
    });
    expect(decodeServerEvent(json).reason).toBe("ok");
  });
});

describe("decodeServerEvent ペイロードの enum/配列/範囲 検証 (#120)", () => {
  const env = { v: 1, seq: 1, ts: "t", session_id: "s1" };
  const validRequirement = {
    id: "r1",
    statement: "ログインできること",
    category: "functional",
    priority: "must",
    confidence: 0.9,
    source_speaker: "user",
    citations: [],
    status: "confirmed",
  };

  it("status.phase が列挙外なら bad-payload", () => {
    expect(decodeServerEvent(bytes({ ...env, type: "status", phase: "dancing" })).reason).toBe(
      "bad-payload",
    );
  });

  it("requirement.priority が列挙外なら bad-payload", () => {
    const { reason } = decodeServerEvent(
      bytes({
        ...env,
        type: "requirement.upserted",
        requirement: { ...validRequirement, priority: "urgent" },
      }),
    );
    expect(reason).toBe("bad-payload");
  });

  it("requirement.confidence が 0–1 の範囲外なら bad-payload", () => {
    const { reason } = decodeServerEvent(
      bytes({
        ...env,
        type: "requirement.upserted",
        requirement: { ...validRequirement, confidence: 1.5 },
      }),
    );
    expect(reason).toBe("bad-payload");
  });

  it("完全に妥当な requirement.upserted は ok", () => {
    const { reason, event } = decodeServerEvent(
      bytes({ ...env, type: "requirement.upserted", requirement: validRequirement }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("requirement.upserted");
  });

  const validNode = {
    id: "nq1",
    parent_id: null,
    kind: "gap",
    text: "通知の保存タイミング",
    status: "open",
    confidence: 0.7,
    depth: 1,
    origin: "conversation",
    refs: ["u1"],
    created_seq: 10,
    resolved_seq: null,
  };

  it("inquiry.node は op と node が妥当なら ok（ADR-0059）", () => {
    const { reason, event } = decodeServerEvent(
      bytes({ ...env, type: "inquiry.node", op: "upsert", node: validNode }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("inquiry.node");
  });

  it("inquiry.node の op が列挙外なら bad-payload", () => {
    expect(
      decodeServerEvent(bytes({ ...env, type: "inquiry.node", op: "merge", node: validNode }))
        .reason,
    ).toBe("bad-payload");
  });

  it("inquiry.node の node.kind が列挙外なら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "inquiry.node", op: "upsert", node: { ...validNode, kind: "note" } }),
      ).reason,
    ).toBe("bad-payload");
  });

  it("inquiry.node の node.refs が配列でないなら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "inquiry.node", op: "upsert", node: { ...validNode, refs: "u1" } }),
      ).reason,
    ).toBe("bad-payload");
  });

  it("inquiry.node の node が欠落なら bad-payload", () => {
    expect(
      decodeServerEvent(bytes({ ...env, type: "inquiry.node", op: "upsert" })).reason,
    ).toBe("bad-payload");
  });

  it("analysis.progress の pct が 100 超なら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "analysis.progress", asset_id: "a1", pct: 140, stage: "ocr" }),
      ).reason,
    ).toBe("bad-payload");
  });

  it("analysis.progress の pct が範囲内（0–100）なら ok", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "analysis.progress", asset_id: "a1", pct: 42, stage: "ocr" }),
      ).reason,
    ).toBe("ok");
  });

  it("context.progress は source/stage が妥当なら ok（P1-a）", () => {
    const { reason, event } = decodeServerEvent(
      bytes({
        ...env,
        type: "context.progress",
        source: "repo",
        stage: "reused",
        label: "octo/app@main",
        detail: "索引済みを利用",
      }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("context.progress");
  });

  it("context.progress は source=materials も ok（ADR-0064）", () => {
    const { reason, event } = decodeServerEvent(
      bytes({
        ...env,
        type: "context.progress",
        source: "materials",
        stage: "done",
        label: "参考資料 2件",
        detail: "解析済みの資料を会話の前提に読み込み",
      }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("context.progress");
  });

  it("context.progress の source が列挙外なら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "context.progress", source: "video", stage: "done" }),
      ).reason,
    ).toBe("bad-payload");
  });

  it("context.progress の stage が列挙外なら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({ ...env, type: "context.progress", source: "prep", stage: "ocr" }),
      ).reason,
    ).toBe("bad-payload");
  });

  it("session.end_proposed は 3 つの件数が数値なら ok（P1-b）", () => {
    const { reason, event } = decodeServerEvent(
      bytes({
        ...env,
        type: "session.end_proposed",
        open_count: 0,
        requirement_count: 5,
        material_count: 2,
      }),
    );
    expect(reason).toBe("ok");
    expect(event?.type).toBe("session.end_proposed");
  });

  it("session.end_proposed の件数が数値でないなら bad-payload", () => {
    expect(
      decodeServerEvent(
        bytes({
          ...env,
          type: "session.end_proposed",
          open_count: "0",
          requirement_count: 5,
          material_count: 2,
        }),
      ).reason,
    ).toBe("bad-payload");
  });

});

describe("encodeUserSelection", () => {
  it("builds a contract-shaped user.selection envelope (§4.5)", () => {
    const bytes = encodeUserSelection("s1", "d1", "relevance", 1, "2026-06-24T00:00:00Z");
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    expect(obj).toMatchObject({
      v: 1,
      type: "user.selection",
      seq: 1,
      session_id: "s1",
      detection_id: "d1",
      selected_value: "relevance",
    });
  });
});

describe("encodeUserText", () => {
  it("builds a contract-shaped user.text envelope (§4.5 / #185)", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserText("s1", "新着順で", 2, "2026-06-24T00:00:00Z")),
    );
    expect(obj).toMatchObject({ v: 1, type: "user.text", seq: 2, session_id: "s1", text: "新着順で" });
  });
});

describe("encodeUserInterrupt", () => {
  it("PTT 押下開始の user.interrupt エンベロープを組む（§4.5 / ADR-0066 S3）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserInterrupt("s1", 6, "2026-07-12T00:00:00Z")),
    );
    expect(obj).toMatchObject({
      v: 1,
      type: "user.interrupt",
      seq: 6,
      session_id: "s1",
      ts: "2026-07-12T00:00:00Z",
    });
  });
});

describe("encodeUserInquiryDrop", () => {
  it("手動 drop の user.inquiry_drop エンベロープを組む（ADR-0059）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserInquiryDrop("s1", "nq-a1", 5, "2026-06-24T00:00:00Z")),
    );
    expect(obj).toMatchObject({
      v: 1,
      type: "user.inquiry_drop",
      seq: 5,
      session_id: "s1",
      node_id: "nq-a1",
    });
  });
});

describe("encodeUserMicMode", () => {
  it("マイク操作モードの user.mic_mode エンベロープを組む（ADR-0073）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserMicMode("s1", "ptt", 7, "2026-07-13T00:00:00Z")),
    );
    expect(obj).toMatchObject({
      v: 1,
      type: "user.mic_mode",
      seq: 7,
      session_id: "s1",
      mode: "ptt",
      ts: "2026-07-13T00:00:00Z",
    });
  });
});

describe("encodeUserTurnStart", () => {
  it("PTT 押下=発話ターン開始の user.turn_start エンベロープを組む（ADR-0073）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserTurnStart("s1", 8, "2026-07-13T00:00:00Z")),
    );
    expect(obj).toMatchObject({
      v: 1,
      type: "user.turn_start",
      seq: 8,
      session_id: "s1",
    });
  });
});

describe("encodeUserTurnCommit", () => {
  it("PTT 離す=発話ターン確定の user.turn_commit エンベロープを組む（ADR-0073）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserTurnCommit("s1", 9, "2026-07-13T00:00:00Z")),
    );
    expect(obj).toMatchObject({
      v: 1,
      type: "user.turn_commit",
      seq: 9,
      session_id: "s1",
    });
  });
});
