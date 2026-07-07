// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { driveFetchPlan, importDriveFile } from "./googleDrive";


afterEach(() => {
  vi.restoreAllMocks();
});

describe("driveFetchPlan（export/download の振り分け）", () => {
  it("Google ドキュメントは Markdown へ export し .md を付ける", () => {
    const plan = driveFetchPlan({
      id: "d1",
      name: "要件メモ",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(plan.url).toContain("/files/d1/export");
    expect(plan.url).toContain(encodeURIComponent("text/markdown"));
    expect(plan.filename).toBe("要件メモ.md");
  });

  it("スプレッドシートは xlsx へ export する（CSV は先頭シートのみのため）", () => {
    const plan = driveFetchPlan({
      id: "s1",
      name: "課題一覧",
      mimeType: "application/vnd.google-apps.spreadsheet",
    });
    expect(plan.url).toContain("/files/s1/export");
    expect(plan.url).toContain(encodeURIComponent("spreadsheetml.sheet"));
    expect(plan.filename).toBe("課題一覧.xlsx");
  });

  it("スライドはテキストへ export する", () => {
    const plan = driveFetchPlan({
      id: "p1",
      name: "キックオフ資料",
      mimeType: "application/vnd.google-apps.presentation",
    });
    expect(plan.url).toContain("/files/p1/export");
    expect(plan.filename).toBe("キックオフ資料.txt");
  });

  it("通常ファイル（PDF 等）は alt=media でそのまま取得する", () => {
    const plan = driveFetchPlan({ id: "f1", name: "prd.pdf", mimeType: "application/pdf" });
    expect(plan.url).toContain("/files/f1?alt=media");
    expect(plan.filename).toBe("prd.pdf");
  });

  it("既に拡張子が付いている名前には二重に付けない", () => {
    const plan = driveFetchPlan({
      id: "d2",
      name: "spec.md",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(plan.filename).toBe("spec.md");
  });
});

describe("importDriveFile（取得 → File 化）", () => {
  it("アクセストークンを Bearer で送り、取得内容を File にする", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["# spec"], { type: "text/markdown" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = await importDriveFile("tok-1", {
      id: "d1",
      name: "要件メモ",
      mimeType: "application/vnd.google-apps.document",
    });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-1");
    expect(file.name).toBe("要件メモ.md");
    expect(file.type).toBe("text/markdown");
  });

  it("取得失敗（403 等）は例外で知らせる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      importDriveFile("tok", { id: "x", name: "秘密.pdf", mimeType: "application/pdf" }),
    ).rejects.toThrow(/403/);
  });

  it("実体が受理外の形式（zip 等）は例外で弾く（サーバ 415 を踏ませない）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(["PK"], { type: "application/zip" })),
      }),
    );
    await expect(
      importDriveFile("tok", { id: "z", name: "archive.zip", mimeType: "application/zip" }),
    ).rejects.toThrow(/unsupported/);
  });
});
