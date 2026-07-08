// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CoverageProgress } from "./CoverageProgress";

afterEach(cleanup);

describe("CoverageProgress", () => {
  it("観点 0 件では何も描画しない", () => {
    const { container } = render(<CoverageProgress coverage={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("済/未の観点と件数を表示する", () => {
    render(
      <CoverageProgress
        coverage={[
          { label: "性能・レスポンスの要件", covered: true },
          { label: "セキュリティ・権限・データ保護", covered: false },
        ]}
      />,
    );
    expect(screen.getByText("性能・レスポンスの要件")).toBeTruthy();
    expect(screen.getByText("セキュリティ・権限・データ保護")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
