// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeStore } from "../lib/realtime/store";
import type { ServerEvent } from "../lib/realtime/types";
import { DetectionSheet } from "./DetectionSheet";

afterEach(cleanup);

function stateWithContradiction() {
  const s = new RealtimeStore();
  const ev: ServerEvent = {
    v: 1,
    type: "detection.contradiction",
    seq: 1,
    ts: "t",
    session_id: "s1",
    id: "d1",
    summary: "関連度順と新着順が食い違う",
    refs: ["u1", "u2"],
    options: [
      { label: "関連度順にする", value: "relevance" },
      { label: "新着順にする", value: "recency" },
    ],
    detector: "contradiction_detector",
  };
  s.apply(ev);
  return s.getSnapshot();
}

describe("DetectionSheet (#97)", () => {
  it("renders the detection with a color-independent label + icon", () => {
    render(<DetectionSheet state={stateWithContradiction()} onSelect={() => {}} />);
    // ラベル（色のみに依存しない判別）。
    expect(screen.getByText("矛盾を検知")).toBeTruthy();
    expect(screen.getByText("関連度順と新着順が食い違う")).toBeTruthy();
    // refs（根拠の発話）の導線。
    expect(screen.getByText(/#u1/)).toBeTruthy();
  });

  it("sends user.selection with the tapped option value", () => {
    const onSelect = vi.fn();
    render(<DetectionSheet state={stateWithContradiction()} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("関連度順にする"));
    expect(onSelect).toHaveBeenCalledWith("d1", "relevance");
  });

  it("renders nothing when there are no open detections", () => {
    const empty = new RealtimeStore().getSnapshot();
    const { container } = render(<DetectionSheet state={empty} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
