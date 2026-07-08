import { describe, expect, it } from "vitest";

import { issueExportReasonText } from "./issueExport";

describe("issueExportReasonText", () => {
  it("未 finalize は確定を促す文言（#435）", () => {
    expect(issueExportReasonText("not finalized")).toContain("確定");
  });

  it("Issue 権限なしは権限付与を促す文言（#434 タスク2）", () => {
    const text = issueExportReasonText("no issue permission");
    expect(text).toContain("権限");
    expect(text).toContain("Issues");
  });

  it("既知の理由はそれぞれ専用文言（再試行を促さない）", () => {
    expect(issueExportReasonText("not finalized")).not.toContain("時間をおいて");
    expect(issueExportReasonText("no issue permission")).not.toContain("時間をおいて");
    expect(issueExportReasonText("no repo access")).toContain("権限");
  });

  it("未知の理由だけ既定の再試行文言に落ちる", () => {
    expect(issueExportReasonText("issue creation failed")).toContain("時間をおいて");
    expect(issueExportReasonText(undefined)).toContain("時間をおいて");
  });
});
