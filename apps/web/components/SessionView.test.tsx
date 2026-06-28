// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaterialItem } from "@/lib/realtime/selectors";

// #207: 素材投入直後の pending 行の pct/status を画像/動画で出し分ける。
// SessionView は LiveKit と useRealtimeSession に依存するため、表示と realtime は薄くモックし、
// handleFile が pending（extraMaterials）へ積む値だけを検査する。

// LiveKit（音声出力・マイクトグル）は描画と無関係なので無害化する。
vi.mock("@livekit/components-react", () => ({
  RoomAudioRenderer: () => null,
  useTrackToggle: () => ({ enabled: false, toggle: vi.fn() }),
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
vi.mock("@/lib/api", () => ({
  ACCEPTED_IMAGE: ".png",
  ACCEPTED_VIDEO: ".mp4",
  uploadContextFile: (...args: unknown[]) => uploadContextFile(...args),
  fetchContextFiles: () => Promise.resolve({ items: [] }),
  exportRequirements: vi.fn(),
  finalizeSession: vi.fn(),
}));

// ConversationSessionView は pending/中断系の props を捕捉するだけのスパイに置き換える。
let lastMaterials: MaterialItem[] = [];
let lastCancelledIds: ReadonlySet<string> = new Set();
let onCancelMaterial: (id: string) => void = () => {};
vi.mock("./ConversationSessionView", () => ({
  ConversationSessionView: (props: {
    extraMaterials: MaterialItem[];
    cancelledIds?: ReadonlySet<string>;
    onCancelMaterial?: (id: string) => void;
  }) => {
    lastMaterials = props.extraMaterials;
    lastCancelledIds = props.cancelledIds ?? new Set();
    onCancelMaterial = props.onCancelMaterial ?? (() => {});
    return null;
  },
}));

import { SessionView } from "./SessionView";

afterEach(() => {
  cleanup();
  uploadContextFile.mockReset();
  lastMaterials = [];
  lastCancelledIds = new Set();
  onCancelMaterial = () => {};
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
});
