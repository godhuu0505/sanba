// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaterialItem } from "@/lib/realtime/selectors";


vi.mock("@livekit/components-react", () => ({
  RoomAudioRenderer: () => null,
  useTrackToggle: () => ({ enabled: false, toggle: vi.fn() }),
  useSpeakingParticipants: () => [],
  useRoomContext: () => ({
    disconnect: vi.fn(),
    localParticipant: { setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock("livekit-client", () => ({ Track: { Source: { Microphone: "microphone" } } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    driveGranted: null,
    requestDriveAccess: () => Promise.resolve(null),
  }),
}));

vi.mock("@/lib/realtime/useRealtimeSession", () => ({
  useRealtimeSession: () => ({
    state: {},
    metrics: {},
    sendSelection: vi.fn(),
    sendText: vi.fn(),
    sendAnswer: vi.fn(),
    sendInterrupt: vi.fn(),
  }),
}));

const uploadContextFile = vi.fn();
const sendTelemetry = vi.fn();
const deleteContextFile = vi.fn();
vi.mock("@/lib/api", () => ({
  ACCEPTED_IMAGE: ".png",
  ACCEPTED_VIDEO: ".mp4",
  ACCEPTED_DOC: ".md",
  uploadContextFile: (...args: unknown[]) => uploadContextFile(...args),
  fetchContextFiles: () => Promise.resolve({ items: [] }),
  exportRequirements: vi.fn(),
  finalizeSession: vi.fn(),
  sendTelemetry: (...args: unknown[]) => sendTelemetry(...args),
  deleteContextFile: (...args: unknown[]) => deleteContextFile(...args),
}));

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

  it("アップロード中の中断で fetch が中止され（abort）、行は cancelled・id は破棄ガードへ", async () => {
    let captured: AbortSignal | undefined;
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

    onCancelMaterial(tempId);

    await waitFor(() => expect(captured?.aborted).toBe(true));
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
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "vid-x",
      asset_kind: "video",
      analysis_pending: true,
    });
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "clip.mp4")] } });
    const tempId = lastMaterials.at(-1)?.id as string;
    await waitFor(() => expect(lastMaterials.find((m) => m.id === "vid-x")).toBeTruthy());
    onCancelMaterial(tempId);
    await waitFor(() => expect(lastCancelledIds.has("vid-x")).toBe(true));
    expect(lastMaterials.find((m) => m.id === "vid-x")?.status).toBe("cancelled");
  });

  it("中断確定後に成功応答が届いても破棄を維持する（通信レース・Codex P2）", async () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadContextFile.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png")] } });
    const tempId = lastMaterials.at(-1)?.id as string;

    onCancelMaterial(tempId);
    await waitFor(() => expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled"));

    await act(async () => {
      resolveUpload({ indexed_chunks: 1, asset_id: "img-r", analysis_pending: false });
    });

    expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled");
    expect(lastMaterials.some((m) => m.status === "done")).toBe(false);
    expect(lastCancelledIds.has("img-r")).toBe(false);
  });

  it("中断後に同じ asset_id を再アップロードすると復活する（破棄ガードから外す・Codex P2）", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 1,
      asset_id: "hash-1",
      asset_kind: "image",
      analysis_pending: false,
    });
    const { container } = render(<SessionView sessionId="s1" sessionToken="t1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File(["x"], "f.png")] } });
    await waitFor(() => expect(lastMaterials.find((m) => m.id === "hash-1")?.status).toBe("done"));
    onCancelMaterial("hash-1");
    await waitFor(() => expect(lastCancelledIds.has("hash-1")).toBe(true));

    fireEvent.change(input, { target: { files: [new File(["x"], "f.png")] } });
    await waitFor(() => expect(lastCancelledIds.has("hash-1")).toBe(false));
    const rows = lastMaterials.filter((m) => m.id === "hash-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
  });

  it("投入種別の選択で material.source_selected を送る（#232）", () => {
    render(<SessionView sessionId="s1" sessionToken="t1" />);
    act(() => onAddMaterial());
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
    await waitFor(() => expect(deleteContextFile).toHaveBeenCalledWith("s1", "vid-9", "t1"));
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

    onCancelMaterial(tempId);
    await waitFor(() => expect(lastMaterials.find((m) => m.id === tempId)?.status).toBe("cancelled"));
    await act(async () => {
      resolveUpload({ indexed_chunks: 1, asset_id: "img-r", analysis_pending: false });
    });
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
    await waitFor(() => expect(lastCancelledIds.has("vid-err")).toBe(true));
    expect(lastMaterials.find((m) => m.id === "vid-err")?.status).toBe("cancelled");
    await waitFor(() =>
      expect(sendTelemetry).toHaveBeenCalledWith("s1", "material.cancel", { result: "error" }, "t1"),
    );
  });
});
