// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { clearPrep, readPrep, writePrep } from "./prepFormStorage";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("prepFormStorage（02 準備フォームの一時保存 / #179）", () => {
  it("未保存なら空オブジェクト", () => {
    expect(readPrep()).toEqual({});
  });

  it("書いた値を読み戻せる（goal/role/consent）", () => {
    writePrep({
      role: "engineer",
      goal: "検索改善の要件",
      consent: true,
    });
    expect(readPrep()).toEqual({
      role: "engineer",
      goal: "検索改善の要件",
      consent: true,
    });
  });

  it("clearPrep で消える", () => {
    writePrep({ goal: "x" });
    clearPrep();
    expect(readPrep()).toEqual({});
  });

  it("壊れた JSON は空にフォールバック（UI を壊さない）", () => {
    window.sessionStorage.setItem("sanba.prep.v1", "{not json");
    expect(readPrep()).toEqual({});
  });

  it("型が違うフィールドは無視する（consent が文字列等）", () => {
    window.sessionStorage.setItem(
      "sanba.prep.v1",
      JSON.stringify({ role: 1, goal: "ok", consent: "yes" }),
    );
    expect(readPrep()).toEqual({ goal: "ok" });
  });
});
