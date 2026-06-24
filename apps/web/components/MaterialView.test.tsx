// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// LiveKit のルームコンテキスト依存を避けるため最小モック。
vi.mock("@livekit/components-react", () => ({
  useLocalParticipant: () => ({
    localParticipant: {
      setScreenShareEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
    },
  }),
}));

const uploadContextFile = vi.fn();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, uploadContextFile: (...args: unknown[]) => uploadContextFile(...args) };
});

import { MaterialView } from "./MaterialView";

afterEach(() => {
  cleanup();
  uploadContextFile.mockReset();
});

function imageInput() {
  return screen.getByTestId("image-input") as HTMLInputElement;
}

describe("MaterialView 画像アップロード (#103)", () => {
  it("動画アップロードは準備中でグレーアウトされる", () => {
    render(<MaterialView sessionId="s1" sessionToken="tok-1" />);
    const video = screen.getByText("動画をアップロード").closest("button");
    expect(video).toBeTruthy();
    expect((video as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("準備中")).toBeTruthy();
  });

  it("PNG を選ぶとアップロードし asset を一覧に出す", async () => {
    uploadContextFile.mockResolvedValue({
      indexed_chunks: 0,
      asset_id: "asset-abc123",
      asset_kind: "image",
      analysis_pending: false,
    });
    render(<MaterialView sessionId="s1" sessionToken="tok-1" />);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "mock.png", {
      type: "image/png",
    });
    fireEvent.change(imageInput(), { target: { files: [file] } });

    await waitFor(() => expect(uploadContextFile).toHaveBeenCalledWith("s1", file, "tok-1"));
    expect(await screen.findByText("mock.png")).toBeTruthy();
    expect(screen.getByText("解析待ち")).toBeTruthy();
  });

  it("非対応拡張子は弾いてアップロードしない", async () => {
    render(<MaterialView sessionId="s1" sessionToken="tok-1" />);
    const file = new File([new Uint8Array([1, 2, 3])], "evil.exe", {
      type: "application/octet-stream",
    });
    fireEvent.change(imageInput(), { target: { files: [file] } });

    expect(await screen.findByText(/対応していない形式/)).toBeTruthy();
    expect(uploadContextFile).not.toHaveBeenCalled();
  });
});
