
export type ChoiceMode = "hidden" | "min" | "list" | "detail" | "compare";

export interface ChoiceState {
  mode: ChoiceMode;
  count: number;
  focused: number;
  returnTo: "min" | "list";
}

export const initialChoiceState: ChoiceState = {
  mode: "hidden",
  count: 0,
  focused: 0,
  returnTo: "min",
};

export type ChoiceAction =
  | { type: "setQuestion"; count: number }
  | { type: "clearQuestion" }
  | { type: "expand" }
  | { type: "collapse" }
  | { type: "openDetail"; index: number }
  | { type: "openCompare" }
  | { type: "closeOverlay" }
  | { type: "focusNext" }
  | { type: "focusPrev" }
  | { type: "select"; index: number };

const clampIndex = (i: number, count: number): number =>
  count <= 0 ? 0 : Math.min(Math.max(i, 0), count - 1);

const isOverlay = (m: ChoiceMode): boolean => m === "detail" || m === "compare";

export function choiceReducer(state: ChoiceState, action: ChoiceAction): ChoiceState {
  switch (action.type) {
    case "setQuestion":
      if (action.count <= 0) return initialChoiceState;
      return { mode: "min", count: action.count, focused: 0, returnTo: "min" };

    case "clearQuestion":
      return initialChoiceState;

    case "expand":
      return state.mode === "min" ? { ...state, mode: "list" } : state;

    case "collapse":
      return state.mode === "list" ? { ...state, mode: "min" } : state;

    case "openDetail":
      if (state.mode !== "min" && state.mode !== "list") return state;
      return {
        ...state,
        mode: "detail",
        focused: clampIndex(action.index, state.count),
        returnTo: state.mode,
      };

    case "openCompare":
      if (state.mode !== "detail" && state.mode !== "compare" && state.mode !== "list") return state;
      return {
        ...state,
        mode: "compare",
        returnTo: state.mode === "list" ? "list" : state.returnTo,
      };

    case "closeOverlay":
      return isOverlay(state.mode) ? { ...state, mode: state.returnTo } : state;

    case "focusNext":
      if (!isOverlay(state.mode) || state.count <= 0) return state;
      return { ...state, focused: (state.focused + 1) % state.count };

    case "focusPrev":
      if (!isOverlay(state.mode) || state.count <= 0) return state;
      return { ...state, focused: (state.focused - 1 + state.count) % state.count };

    case "select":
      return initialChoiceState;

    default:
      return state;
  }
}
