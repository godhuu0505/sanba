// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Detection } from "@/lib/realtime/types";

import { DeepDiveList } from "./DeepDiveList";

const det = (over: Partial<Detection>): Detection => ({
  id: "d1",
  kind: "contradiction",
  summary: "要約",
  refs: [],
  detector: "x",
  resolved: false,
  ...over,
});

describe("DeepDiveList（深掘り対象＝未解消検知）", () => {
  afterEach(() => cleanup());

  it("空のときは『未解消はありません』を出す", () => {
    render(<DeepDiveList detections={[]} onJump={vi.fn()} />);
    expect(screen.getByText(/未解消はありません/)).toBeTruthy();
  });

  it("食い違い（contradiction）は『食い違い』ラベル＋要約＋会話で確認を出す", () => {
    render(
      <DeepDiveList
        detections={[det({ id: "d1", kind: "contradiction", summary: "並び順の両論あり" })]}
        onJump={vi.fn()}
      />,
    );
    expect(screen.getByText(/食い違い/)).toBeTruthy();
    expect(screen.getByText("並び順の両論あり")).toBeTruthy();
    expect(screen.getByRole("button", { name: /会話で確認/ })).toBeTruthy();
  });

  it("抜け（gap）は『確認したい点』ラベルを出す", () => {
    render(<DeepDiveList detections={[det({ id: "d2", kind: "gap", summary: "並びが未定" })]} onJump={vi.fn()} />);
    expect(screen.getByText(/確認したい点/)).toBeTruthy();
  });

  it("会話で確認で onJump(検知id) が呼ばれる", () => {
    const onJump = vi.fn();
    render(<DeepDiveList detections={[det({ id: "d9" })]} onJump={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: /会話で確認/ }));
    expect(onJump).toHaveBeenCalledWith("d9");
  });
});
