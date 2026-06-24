// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeStore } from "../lib/realtime/store";
import type { ServerEvent } from "../lib/realtime/types";
import { RequirementScroll } from "./RequirementScroll";

afterEach(cleanup);

function stateWithConfirmedRequirement() {
  const s = new RealtimeStore();
  const ev: ServerEvent = {
    v: 1,
    type: "requirement.upserted",
    seq: 1,
    ts: "t",
    session_id: "s1",
    requirement: {
      id: "r1",
      statement: "キーワード検索を新設する",
      category: "functional",
      priority: "must",
      confidence: 0.9,
      source_speaker: "顧客",
      citations: [],
      status: "confirmed",
    },
  };
  s.apply(ev);
  return s.getSnapshot();
}

describe("RequirementScroll (#96)", () => {
  it("groups by MoSCoW and shows the confirmed count in the CTA", () => {
    render(
      <RequirementScroll
        state={stateWithConfirmedRequirement()}
        onExport={async () => ({ exported: true })}
      />,
    );
    expect(screen.getByText("Must 必須")).toBeTruthy();
    expect(screen.getByText("GitHub Issue を作成（1件）")).toBeTruthy();
  });

  it("calls export and shows the resulting issue url", async () => {
    const onExport = vi.fn().mockResolvedValue({
      exported: true,
      issue_url: "https://github.com/godhuu0505/sanba/issues/1",
      count: 1,
    });
    render(<RequirementScroll state={stateWithConfirmedRequirement()} onExport={onExport} />);
    fireEvent.click(screen.getByText("GitHub Issue を作成（1件）"));
    expect(onExport).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/issues\/1/)).toBeTruthy(),
    );
  });
});
