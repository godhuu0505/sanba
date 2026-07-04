import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSession,
  deleteContextFile,
  fetchGithubRepos,
  fetchMySessions,
  sendTelemetry,
} from "./api";

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

describe("createSession（ADR-0026 連携リポジトリ）", () => {
  const ok = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ session_id: "s1", invites: {} }),
    });

  it("githubRepo を渡すと body に github_repo を含める", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await createSession(["pm"], true, null, undefined, "acme/product-a");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sessions");
    expect(JSON.parse(init.body).github_repo).toBe("acme/product-a");
  });

  it("未指定・空文字なら github_repo を送らない（連携しない）", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await createSession(["pm"], true, null);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).github_repo).toBeUndefined();
    await createSession(["pm"], true, null, undefined, "");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).github_repo).toBeUndefined();
  });
});

describe("fetchGithubRepos（ADR-0026 候補一覧）", () => {
  it("GET /api/github/repos を idToken 付きで叩き、結果を返す", async () => {
    const body = { enabled: true, repos: ["acme/product-a"], default: "o/r" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchGithubRepos("idtok");
    expect(res).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/github/repos");
    expect(init.headers.Authorization).toBe("Bearer idtok");
  });

  it("非 2xx は例外を投げる（呼び出し側＝02 準備がフィールド非表示を維持する）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchGithubRepos("idtok")).rejects.toThrow(/500/);
  });
});

describe("fetchMySessions（#250 本人セッション一覧）", () => {
  it("GET /api/sessions/mine を idToken 付きで叩き、一覧を返す", async () => {
    const rows = [
      { id: "s1", title: "要件A", created_at: "2024-06-20T00:00:00Z", status: "active", finalized: false },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rows) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchMySessions("idtok");
    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sessions/mine");
    expect(init.headers.Authorization).toBe("Bearer idtok");
  });

  it("idToken が null なら Authorization を付けない（dev モードは API の bypass に委ねる）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal("fetch", fetchMock);
    await fetchMySessions(null);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("非 2xx は例外を投げる（呼び出し側＝ホームが空状態を維持する）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMySessions("idtok")).rejects.toThrow(/401/);
  });
});
