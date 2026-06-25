"use client";

// 選択肢の開示レベル（最小⇄一覧⇄詳細⇄比較）を React に結線するフック。
// 純レデューサ choiceReducer をラップし、UI から呼ぶアクションを公開する。
// 仕様: docs/design/conversation-experience.md §4。

import { useReducer } from "react";

import { choiceReducer, initialChoiceState, type ChoiceState } from "./choiceDisclosure";

export interface ChoiceDisclosure {
  state: ChoiceState;
  /** 新しい問い（選択肢数）→ 最小構成。 */
  setQuestion: (count: number) => void;
  /** 問いを消す → hidden。 */
  clear: () => void;
  /** 最小 → 一覧。 */
  expand: () => void;
  /** 一覧 → 最小。 */
  collapse: () => void;
  /** 最小（長押し）/一覧（詳細›）→ 詳細。 */
  openDetail: (index: number) => void;
  /** 詳細/一覧 → 比較。 */
  openCompare: () => void;
  /** 詳細/比較 → returnTo。 */
  closeOverlay: () => void;
  /** 詳細/比較で次の選択肢へ。 */
  next: () => void;
  /** 詳細/比較で前の選択肢へ。 */
  prev: () => void;
  /** 回答確定 → 選択肢UIを閉じる。 */
  select: (index: number) => void;
}

export function useChoiceDisclosure(): ChoiceDisclosure {
  const [state, dispatch] = useReducer(choiceReducer, initialChoiceState);
  return {
    state,
    setQuestion: (count) => dispatch({ type: "setQuestion", count }),
    clear: () => dispatch({ type: "clearQuestion" }),
    expand: () => dispatch({ type: "expand" }),
    collapse: () => dispatch({ type: "collapse" }),
    openDetail: (index) => dispatch({ type: "openDetail", index }),
    openCompare: () => dispatch({ type: "openCompare" }),
    closeOverlay: () => dispatch({ type: "closeOverlay" }),
    next: () => dispatch({ type: "focusNext" }),
    prev: () => dispatch({ type: "focusPrev" }),
    select: (index) => dispatch({ type: "select", index }),
  };
}
