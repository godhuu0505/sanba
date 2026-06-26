// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useChoiceDisclosure } from "./useChoiceDisclosure";

describe("useChoiceDisclosure（純レデューサの React 結線）", () => {
  it("hidden→min→list→detail(focused)→select→hidden を辿れる", () => {
    const { result } = renderHook(() => useChoiceDisclosure());
    expect(result.current.state.mode).toBe("hidden");

    act(() => result.current.setQuestion(4));
    expect(result.current.state.mode).toBe("min");
    expect(result.current.state.count).toBe(4);

    act(() => result.current.expand());
    expect(result.current.state.mode).toBe("list");

    act(() => result.current.openDetail(2));
    expect(result.current.state.mode).toBe("detail");
    expect(result.current.state.focused).toBe(2);

    act(() => result.current.openCompare());
    expect(result.current.state.mode).toBe("compare");

    act(() => result.current.closeOverlay());
    expect(result.current.state.mode).toBe("list");

    act(() => result.current.select(0));
    expect(result.current.state.mode).toBe("hidden");
  });
});
