import { describe, expect, it } from "vitest";
import {
  decodeServerEvent,
  encodeUserAnswered,
  encodeUserSelection,
  encodeUserText,
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
    // requirement.upserted なのに requirement が無い → store.apply で落ちる前に弾く。
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
        requirement: { id: "r1" }, // statement 等が欠落
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

describe("encodeUserAnswered", () => {
  it("選択肢値での回答（§4.5 / #181）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(
        encodeUserAnswered("s1", "q1", { selectedValue: "relevance" }, 3, "t"),
      ),
    );
    expect(obj).toMatchObject({
      type: "user.answered",
      question_id: "q1",
      selected_value: "relevance",
    });
    expect(obj.text).toBeUndefined();
  });

  it("自由記述での回答（text のみ）", () => {
    const obj = JSON.parse(
      new TextDecoder().decode(encodeUserAnswered("s1", "q1", { text: "関連度順" }, 4, "t")),
    );
    expect(obj).toMatchObject({ type: "user.answered", question_id: "q1", text: "関連度順" });
    expect(obj.selected_value).toBeUndefined();
  });
});
