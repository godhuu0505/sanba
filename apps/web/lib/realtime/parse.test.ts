import { describe, expect, it } from "vitest";
import { decodeServerEvent } from "./parse";

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
