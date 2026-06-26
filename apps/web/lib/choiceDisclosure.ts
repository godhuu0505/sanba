// 選択肢の開示レベル（最小 ⇄ 一覧 ⇄ 詳細 ⇄ 比較）を管理する純レデューサ。
// 仕様: docs/design/conversation-experience.md §4。
//   - min   : 常時ピンの最小構成（横スクロールchip）。chip タップ=回答 / 長押し=詳細 / ⤢=一覧
//   - list  : 展開カード（行タップ=即選択 / 各行 詳細› / ⤡=最小）
//   - detail: ボトムシート（1選択肢を深掘り・前後で巡回 / これを選ぶ=確定 / ✕=returnTo）
//   - compare: 全選択肢を効き目/留意で横並び（detail/list から切替）
//   - hidden: 問いが無い（回答確定後など）

export type ChoiceMode = "hidden" | "min" | "list" | "detail" | "compare";

export interface ChoiceState {
  mode: ChoiceMode;
  /** 選択肢の数（focus 巡回・index クランプに使う）。 */
  count: number;
  /** detail/compare でフォーカス中の選択肢 index。 */
  focused: number;
  /** detail/compare を閉じたときに戻る先。 */
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
      // 最小（長押し）・一覧（詳細›）から詳細へ。戻り先を覚えておく。
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
      // 回答確定 → 選択肢UIを閉じる。次の問いが来たら setQuestion で min に復帰する。
      return initialChoiceState;

    default:
      return state;
  }
}
