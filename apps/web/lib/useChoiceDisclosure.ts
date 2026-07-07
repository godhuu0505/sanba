"use client";


import { useCallback, useReducer } from "react";

import { choiceReducer, initialChoiceState, type ChoiceState } from "./choiceDisclosure";

export interface ChoiceDisclosure {
  state: ChoiceState;
  setQuestion: (count: number) => void;
  clear: () => void;
  expand: () => void;
  collapse: () => void;
  openDetail: (index: number) => void;
  openCompare: () => void;
  closeOverlay: () => void;
  next: () => void;
  prev: () => void;
  select: (index: number) => void;
}

export function useChoiceDisclosure(): ChoiceDisclosure {
  const [state, dispatch] = useReducer(choiceReducer, initialChoiceState);
  return {
    state,
    setQuestion: useCallback((count: number) => dispatch({ type: "setQuestion", count }), []),
    clear: useCallback(() => dispatch({ type: "clearQuestion" }), []),
    expand: useCallback(() => dispatch({ type: "expand" }), []),
    collapse: useCallback(() => dispatch({ type: "collapse" }), []),
    openDetail: useCallback((index: number) => dispatch({ type: "openDetail", index }), []),
    openCompare: useCallback(() => dispatch({ type: "openCompare" }), []),
    closeOverlay: useCallback(() => dispatch({ type: "closeOverlay" }), []),
    next: useCallback(() => dispatch({ type: "focusNext" }), []),
    prev: useCallback(() => dispatch({ type: "focusPrev" }), []),
    select: useCallback((index: number) => dispatch({ type: "select", index }), []),
  };
}
