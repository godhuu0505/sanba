import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyFileUpload,
  classifyUpload,
  createSession,
  deleteContextFile,
  fetchGithubRepos,
  fetchMySessions,
  sendTelemetry,
  setAuthNonce,
} from "./api";

// 素材の観測テレメトリ送信（#232/#243）とサーバ破棄（#245）の API シーム。
// fetch をスタブし、送信先・列挙属性・失敗の握りつぶし・冪等 DELETE の契約を検証する。

afterEach(() => {
  vi.restoreAllMocks();
  // モジュールレベルの ambient 状態（ADR-0046 §2）をテスト間で持ち越さない。
  setAuthNonce(null);
});

describe("setAuthNonce / X-Auth-Nonce（ADR-0046 §2）", () => {
  it("有効化中は authorized リクエストに X-Auth-Nonce が載る", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal("fetch", fetchMock);

    setAuthNonce("envelope-1");
    await fetchMySessions("idtok");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Auth-Nonce"]).toBe("envelope-1");
    expect(init.headers.Authorization).toBe("Bearer idtok");
  });

  it("null で破棄するとヘッダごと消える（ログアウト後に送出し続けない）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal("fetch", fetchMock);

    setAuthNonce("envelope-1");
    setAuthNonce(null);
    await fetchMySessions("idtok");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Auth-Nonce"]).toBeUndefined();
  });
});

describe("classifyUpload / classifyFileUpload（受理判定・ADR-0044）", () => {
  it("画像/動画に加えて資料（md/pdf/html/csv/json/Office）を受理する", () => {
    expect(classifyUpload("mock.png")).toBe("image");
    expect(classifyUpload("rec.MOV")).toBe("video");
    expect(classifyUpload("spec.md")).toBe("doc");
    expect(classifyUpload("prd.pdf")).toBe("doc");
    expect(classifyUpload("page.html")).toBe("doc");
    expect(classifyUpload("data.csv")).toBe("doc");
    expect(classifyUpload("conf.json")).toBe("doc");
    expect(classifyUpload("spec.docx")).toBe("doc");
    expect(classifyUpload("req.xlsx")).toBe("doc");
    expect(classifyUpload("deck.pptx")).toBe("doc");
    expect(classifyUpload("malware.exe")).toBeNull();
  });

  it("拡張子が無くても MIME が受理範囲なら通す（API と整合）", () => {
    expect(classifyFileUpload({ name: "clipboard-image", type: "image/png" })).toBe("image");
    expect(classifyFileUpload({ name: "exported", type: "text/markdown" })).toBe("doc");
    expect(
      classifyFileUpload({
        name: "book",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("doc");
    expect(classifyFileUpload({ name: "archive", type: "application/zip" })).toBeNull();
  });
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

describe("createSession（ADR-0027 連携リポジトリ）", () => {
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

  it("未指定なら送らず（フォールバック）、空文字は明示的な連携なしとして送る", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await createSession(["pm"], true, null);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).github_repo).toBeUndefined();
    await createSession(["pm"], true, null, undefined, "");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).github_repo).toBe("");
  });
});

describe("fetchGithubRepos（ADR-0027 候補一覧）", () => {
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
