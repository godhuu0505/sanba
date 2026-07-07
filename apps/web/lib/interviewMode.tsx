"use client";


import { createContext, useContext } from "react";

export type InterviewMode = "developer" | "end_user";

const InterviewModeContext = createContext<InterviewMode>("developer");

export const InterviewModeProvider = InterviewModeContext.Provider;

export function useInterviewMode(): InterviewMode {
  return useContext(InterviewModeContext);
}
