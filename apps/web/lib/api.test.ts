import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteContextFile, sendTelemetry } from "./api";

// 素材の観測テレメトリ送信（#232/#243）とサーバ破棄（#245）の API シーム。
// fetch をスタブし、送信先・列挙属性・失敗の握りつぶし・冪等 DELETE の契約を検証する。

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendTelemetry（#232/#243 送信シーム）", () => {
  it("POST /telemetry に event＋列挙属性を keepalive 付きで送る", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    sendTelemetry(
      "s1",
      "material.source_selected",
      { source: "camera" },
      "tok",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sessions/s1/telemetry");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      event: "material.source_selected",
      source: "camera",
    });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("送信失敗（reject）を握りつぶし、呼び出し側へ throw しない（UX を止めない）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    // 同期的に throw しないこと。
    expect(() =>
      sendTelemetry("s1", "material.cancel", { result: "aborted" }, null),
    ).not.toThrow();
    // マイクロタスクを流して未処理 rejection が出ないことを確かめる。
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteContextFile（#245 真の破棄）", () => {
  it("DELETE /context/file/{id} を叩き、結果 JSON を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deleted: true, existed: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteContextFile("s1", "asset-abc", "tok");
    expect(res).toEqual({ deleted: true, existed: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sessions/s1/context/file/asset-abc");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("非 2xx は例外を投げる（呼び出し側が再試行/残置を判断する）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteContextFile("s1", "asset-abc", null)).rejects.toThrow(
      /500/,
    );
  });
});
