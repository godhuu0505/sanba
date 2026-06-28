// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaterialItem } from "@/lib/realtime/selectors";

// #207: 素材投入直後の pending 行の pct/status を画像/動画で出し分ける。
// SessionView は LiveKit と useRealtimeSession に依存するため、表示と realtime は薄くモックし、
// handleFile が pending（extraMaterials）へ積む値だけを検査する。

// LiveKit（音声出力・マイクトグル）は描画と無関係なので無害化する。
vi.mock("@livekit/components-react", () => ({
  RoomAudioRenderer: () => null,
  useTrackToggle: () => ({ enabled: false, toggle: vi.fn() }),
  useSpeakingParticipants: () => [],
}));
vi.mock("livekit-client", () => ({ Track: { Source: { Microphone: "microphone" } } }));

// realtime 購読は本テストの対象外。最小の state を返す。
vi.mock("@/lib/realtime/useRealtimeSession", () => ({
  useRealtimeSession: () => ({
    state: {},
    metrics: {},
    sendSelection: vi.fn(),
    sendText: vi.fn(),
    sendAnswer: vi.fn(),
  }),
}));

// api: アップロード結果は各テストで差し替える。ハイドレーションは空で解決させる。
const uploadContextFile = vi.fn();
const sendTelemetry = vi.fn();
const deleteContextFile = vi.fn();
vi.mock("@/lib/api", () => ({
  ACCEPTED_IMAGE: ".png",
  ACCEPTED_VIDEO: ".mp4",
  uploadContextFile: (...args: unknown[]) => uploadContextFile(...args),
  fetchContextFiles: () => Promise.resolve({ items: [] }),
  exportRequirements: vi.fn(),
  finalizeSession: vi.fn(),
  sendTelemetry: (...args: unknown[]) => sendTelemetry(...args),
  deleteContextFile: (...args: unknown[]) => deleteContextFile(...args),
}));

// ConversationSessionView は pending/中断系の props を捕捉するだけのスパイに置き換える。
let lastMaterials: MaterialItem[] = [];
let lastCancelledIds: ReadonlySet<string> = new Set();
let onCancelMaterial: (id: string) => void = () => {};
let onAddMaterial: () => void = () => {};
vi.mock("./ConversationSessionView", () => ({
  ConversationSessionView: (props: {
    extraMaterials: MaterialItem[];
    cancelledIds?: ReadonlySet<string>;
    onCancelMaterial?: (id: string) => void;
    onAddMaterial?: () => void;
  }) => {
    lastMaterials = props.extraMaterials;
    lastCancelledIds = props.cancelledIds ?? new Set();
    onCancelMaterial = props.onCancelMaterial ?? (() => {});
    onAddMaterial = props.onAddMaterial ?? (() => {});
    return null;
  },
}));

import { SessionView } from "./SessionView";

afterEach(() => {
  cleanup();
  uploadContextFile.mockReset();
  sendTelemetry.mockReset();
  deleteContextFile.mockReset();
  deleteContextFile.mockResolvedValue({ deleted: true, existed: true });
  lastMaterials = [];
  lastCancelledIds = new Set();
  onCancelMaterial = () => {};
  onAddMaterial = () => {};
});

async function uploadFile(filename: string): Promise<MaterialItem> {
  const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["x"], filename);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(lastMaterials.at(-1)?.status).not.toBe("uploading"));
  return lastMaterials.at(-1) as MaterialItem;
}

describe("SessionView handleFile pending 行", () => {
  it("画像（analysis_pending=false）は done / pct=100", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 1,
      asset_id: "img-1",
      asset_kind: "image",
      analysis_pending: false,
    });
    const row = await uploadFile("photo.png");
    expect(row).toMatchObject({ id: "img-1", status: "done", pct: 100 });
  });

  it("動画（analysis_pending=true）は analyzing / pct=0（準備中）", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-1",
      asset_kind: "video",
      analysis_pending: true,
    });
    const row = await uploadFile("clip.mp4");
    expect(row).toMatchObject({ id: "vid-1", status: "analyzing", pct: 0 });
  });

  it("analysis_pending 未指定は done 相当（完了）", async () => {
    uploadContextFile.mockResolvedValue({ indexed_chunks: 1, asset_id: "img-2" });
    const row = await uploadFile("photo.jpg");
    expect(row).toMatchObject({ id: "img-2", status: "done", pct: 100 });
  });

  it("失敗時は failed のまま（pct は据え置き）", async () => {
    uploadContextFile.mockRejectedValue(new Error("upload failed: 415"));
    const row = await uploadFile("bad.png");
    expect(row.status).toBe("failed");
    expect(row.pct).toBe(0);
  });

  it("アップロード中は uploading / pct=0 で先に行を出す", async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadContextFile.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    expect(lastMaterials.at(-1)).toMatchObject({ status: "uploading", pct: 0 });
    resolveUpload({ indexed_chunks: 1, asset_id: "img-3", analysis_pending: false });
    await waitFor(() => expect(lastMaterials.at(-1)?.status).toBe("done"));
  });

  // ── 中断（#219）─────────────────────────────────────────────────────
  it("アップロード中の中断で fetch が中止され（abort）、行は cancelled・id は破棄ガードへ", async () => {
    let captured: AbortSignal | undefined;
    // 中止されるまで解決しない fetch。abort で AbortError を投げる本物の挙動を模す。
    uploadContextFile.mockImplementation(
      (_s: string, _f: File, _t: string | null, signal?: AbortSignal) => {
        captured = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    );
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    const tempId = lastMaterials.at(-1)?.id as string;
    expect(lastMaterials.at(-1)).toMatchObject({ id: tempId, status: "uploading" });

    // 中断を確定する。
    onCancelMaterial(tempId);

    // 送信中の fetch が中止される。
    await waitFor(() => expect(captured?.aborted).toBe(true));
    // 行は cancelled（failed に上書きされない）／破棄 id はガードへ積まれる。
    await waitFor(() => expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled"));
    expect(lastCancelledIds.has(tempId)).toBe(true);
  });

  it("解析中（動画準備中）の中断は asset_id を破棄ガードへ積む（遅延 analysis.* の復活防止）", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-9",
      asset_kind: "video",
      analysis_pending: true,
    });
    const row = await uploadFile("clip.mp4");
    expect(row).toMatchObject({ id: "vid-9", status: "analyzing" });
    onCancelMaterial("vid-9");
    await waitFor(() => expect(lastCancelledIds.has("vid-9")).toBe(true));
    expect(lastMaterials.find((m) => m.id === "vid-9")?.status).toBe("cancelled");
  });

  it("ダイアログを tempId で開いた後に成功しても、古い tempId で中断できる（id 差替えの競合・Codex P2）", async () => {
    // 確認ダイアログを開いた時点では行 id は local:*（uploading）。確定前にアップロードが成功し、
    // 行 id は asset_id（vid-x）に差し替わる。確定時は古い tempId が渡るが、両 id を破棄する。
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-x",
      asset_kind: "video",
      analysis_pending: true,
    });
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "clip.mp4")] } });
    const tempId = lastMaterials.at(-1)?.id as string; // local:* を捕捉（ダイアログを開いた時点）。
    // アップロード成功で行 id が asset_id へ差し替わるのを待つ。
    await waitFor(() => expect(lastMaterials.find((m) => m.id === "vid-x")).toBeTruthy());
    // 古い tempId で中断を確定する。
    onCancelMaterial(tempId);
    // asset_id 側がガードへ積まれ（遅延 analysis.* で復活しない）、行も cancelled になる。
    await waitFor(() => expect(lastCancelledIds.has("vid-x")).toBe(true));
    expect(lastMaterials.find((m) => m.id === "vid-x")?.status).toBe("cancelled");
  });

  it("中断確定後に成功応答が届いても破棄を維持する（通信レース・Codex P2）", async () => {
    // abort の直前にレスポンスが解決済みだと await は成功する。成功処理で破棄が取り消されてはいけない。
    let resolveUpload: (v: unknown) => void = () => {};
    uploadContextFile.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    const tempId = lastMaterials.at(-1)?.id as string;

    // 中断確定（abort）。行は cancelled になる。
    onCancelMaterial(tempId);
    await waitFor(() => expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled"));

    // abort 直前に解決済みだった成功応答が届く（成功値で resolve）。
    await act(async () => {
      resolveUpload({ indexed_chunks: 1, asset_id: "img-r", analysis_pending: false });
    });

    // 成功は反映されず破棄を維持（行は cancelled・done に戻らない）。
    expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled");
    expect(lastMaterials.some((m) => m.status === "done")).toBe(false);
    // 古い中断応答は content-hash の asset_id を破棄ガードへ積まない（同一ファイル再投入を隠さない・Codex P2）。
    expect(lastCancelledIds.has("img-r")).toBe(false);
  });

  it("中断後に同じ asset_id を再アップロードすると復活する（破棄ガードから外す・Codex P2）", async () => {
    // API は内容ハッシュで安定 asset_id を返すため、再投入で同じ id が返る。
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 1,
      asset_id: "hash-1",
      asset_kind: "image",
      analysis_pending: false,
    });
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    // 1回目: アップロード成功 → 中断（破棄）。
    fireEvent.change(input, { target: { files: [new File(["x"], "f.png")] } });
    await waitFor(() => expect(lastMaterials.find((m) => m.id === "hash-1")?.status).toBe("done"));
    onCancelMaterial("hash-1");
    await waitFor(() => expect(lastCancelledIds.has("hash-1")).toBe(true));

    // 2回目: 同じファイル＝同じ asset_id を再投入 → 破棄ガードから外れ、行が復活する。
    fireEvent.change(input, { target: { files: [new File(["x"], "f.png")] } });
    await waitFor(() => expect(lastCancelledIds.has("hash-1")).toBe(false));
    const rows = lastMaterials.filter((m) => m.id === "hash-1");
    // 古い cancelled tombstone は消え、done 行だけが残る（重複なし）。
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
  });

  // ── 観測テレメトリ（#232 投入種別 / #243 中断）と真の破棄（#245）──────────
  it("投入種別の選択で material.source_selected を送る（#232）", () => {
    render(<SessionView sessionId="s1" sessionToken="t1" />);
    act(() => onAddMaterial()); // 手段選択シートを開く。
    fireEvent.click(screen.getByRole("button", { name: /ファイルをアップロード/ }));
    expect(sendTelemetry).toHaveBeenCalledWith(
      "s1",
      "material.source_selected",
      { source: "upload" },
      "t1",
    );
  });

  it("アップロード中の中断で material.cancel(status=uploading/result=aborted) を送る（#243）", async () => {
    uploadContextFile.mockImplementation(
      (_s: string, _f: File, _t: string | null, signal?: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        ),
    );
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    const tempId = lastMaterials.at(-1)?.id as string;
    onCancelMaterial(tempId);
    await waitFor(() =>
      expect(sendTelemetry).toHaveBeenCalledWith(
        "s1",
        "material.cancel",
        { status: "uploading", result: "aborted" },
        "t1",
      ),
    );
    // 送信中アップロード（tempId=local:*）はサーバに実体が無いため DELETE は呼ばない。
    expect(deleteContextFile).not.toHaveBeenCalled();
  });

  it("解析中の中断はサーバ破棄 DELETE を呼び material.cancel(discarded) を送る（#245/#243）", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-9",
      asset_kind: "video",
      analysis_pending: true,
    });
    const row = await uploadFile("clip.mp4");
    expect(row.id).toBe("vid-9");
    onCancelMaterial("vid-9");
    // (1) サーバ側 binary・メタ・grounding 索引の取消を呼ぶ（リロードでの復活・grounding 残留を断つ）。
    await waitFor(() => expect(deleteContextFile).toHaveBeenCalledWith("s1", "vid-9", "t1"));
    // (2) 中断は abort 無し（既に成功済み）なので result=discarded。
    expect(sendTelemetry).toHaveBeenCalledWith(
      "s1",
      "material.cancel",
      { status: "analyzing", result: "discarded" },
      "t1",
    );
  });

  it("中断確定後に成功応答が届いたら、確定 asset をサーバ破棄して残留を断つ（#245 レース）", async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadContextFile.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    const tempId = lastMaterials.at(-1)?.id as string;

    onCancelMaterial(tempId); // abort 確定（行は cancelled）。
    await waitFor(() => expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled"));
    // abort 直前に解決済みだった成功応答が届く（grounding/メタはサーバに作られている）。
    await act(async () => {
      resolveUpload({ indexed_chunks: 1, asset_id: "img-r", analysis_pending: false });
    });
    // 確定 asset_id をサーバ側でも破棄する（クライアント破棄だけでは観察が残るため）。
    await waitFor(() => expect(deleteContextFile).toHaveBeenCalledWith("s1", "img-r", "t1"));
  });

  it("サーバ破棄に失敗しても UX を止めず、result=error を観測へ記録する（#245 失敗時）", async () => {
    deleteContextFile.mockRejectedValue(new Error("delete context file failed: 500"));
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-err",
      asset_kind: "video",
      analysis_pending: true,
    });
    await uploadFile("clip.mp4");
    onCancelMaterial("vid-err");
    // ローカル破棄（cancelled・ガード）は維持される。
    await waitFor(() => expect(lastCancelledIds.has("vid-err")).toBe(true));
    expect(lastMaterials.find((m) => m.id === "vid-err")?.status).toBe("cancelled");
    // 破棄失敗は result=error で記録する（握りつぶしつつ観測する）。
    await waitFor(() =>
      expect(sendTelemetry).toHaveBeenCalledWith("s1", "material.cancel", { result: "error" }, "t1"),
    );
  });
});
