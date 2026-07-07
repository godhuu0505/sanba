import { describe, expect, it } from "vitest";

import { choiceReducer, initialChoiceState } from "./choiceDisclosure";

describe("choiceReducer（選択肢4モード切替）", () => {
  it("初期は hidden（問いが無い）", () => {
    expect(initialChoiceState.mode).toBe("hidden");
  });

  it("setQuestion(count>0) で最小構成（min）になり options 数を持つ", () => {
    const s = choiceReducer(initialChoiceState, { type: "setQuestion", count: 4 });
    expect(s.mode).toBe("min");
    expect(s.count).toBe(4);
    expect(s.focused).toBe(0);
  });

  it("clearQuestion で hidden に戻る", () => {
    const s1 = choiceReducer(initialChoiceState, { type: "setQuestion", count: 3 });
    const s2 = choiceReducer(s1, { type: "clearQuestion" });
    expect(s2.mode).toBe("hidden");
  });

  it("min --expand--> list、list --collapse--> min", () => {
    const min = choiceReducer(initialChoiceState, { type: "setQuestion", count: 3 });
    const list = choiceReducer(min, { type: "expand" });
    expect(list.mode).toBe("list");
    const back = choiceReducer(list, { type: "collapse" });
    expect(back.mode).toBe("min");
  });

  it("expand は min からのみ有効（detail からは no-op）", () => {
    const detail = choiceReducer(
      choiceReducer(initialChoiceState, { type: "setQuestion", count: 3 }),
      { type: "openDetail", index: 1 },
    );
    expect(choiceReducer(detail, { type: "expand" })).toEqual(detail);
  });

  it("min から長押しで openDetail → detail（returnTo=min）、closeOverlay で min に戻る", () => {
    const min = choiceReducer(initialChoiceState, { type: "setQuestion", count: 4 });
    const detail = choiceReducer(min, { type: "openDetail", index: 2 });
    expect(detail.mode).toBe("detail");
    expect(detail.focused).toBe(2);
    expect(detail.returnTo).toBe("min");
    expect(choiceReducer(detail, { type: "closeOverlay" }).mode).toBe("min");
  });

  it("list の詳細› から openDetail → detail（returnTo=list）、closeOverlay で list に戻る", () => {
    const list = choiceReducer(
      choiceReducer(initialChoiceState, { type: "setQuestion", count: 4 }),
      { type: "expand" },
    );
    const detail = choiceReducer(list, { type: "openDetail", index: 1 });
    expect(detail.returnTo).toBe("list");
    expect(choiceReducer(detail, { type: "closeOverlay" }).mode).toBe("list");
  });

  it("detail --openCompare--> compare、closeOverlay は returnTo へ戻る", () => {
    const detail = choiceReducer(
      choiceReducer(initialChoiceState, { type: "setQuestion", count: 4 }),
      { type: "openDetail", index: 0 },
    );
    const compare = choiceReducer(detail, { type: "openCompare" });
    expect(compare.mode).toBe("compare");
    expect(choiceReducer(compare, { type: "closeOverlay" }).mode).toBe("min");
  });

  it("detail で focusNext/focusPrev が options を巡回（端で wrap）", () => {
    let s = choiceReducer(
      choiceReducer(initialChoiceState, { type: "setQuestion", count: 3 }),
      { type: "openDetail", index: 2 },
    );
    s = choiceReducer(s, { type: "focusNext" });
    expect(s.focused).toBe(0);
    s = choiceReducer(s, { type: "focusPrev" });
    expect(s.focused).toBe(2);
  });

  it("select すると hidden に閉じる（回答確定→選択肢UIは閉じる）", () => {
    const list = choiceReducer(
      choiceReducer(initialChoiceState, { type: "setQuestion", count: 4 }),
      { type: "expand" },
    );
    expect(choiceReducer(list, { type: "select", index: 1 }).mode).toBe("hidden");
  });
});
