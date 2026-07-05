"use client";

// インタビュー・モードの共有コンテキスト（ADR-0032 / FR-2.3・FR-2.4）。
// SessionMeta.interview_mode（developer | end_user）を会話画面の表示部品へ配る。
// end_user モードでは検知バッジ・MoSCoW 等の開発語彙を利用者向け文言へ切替える
// （mapping.ts の mode 引数と対）。既定は developer（従来画面は Provider 無しで不変）。
//
// prop drilling ではなく Context にする理由: 語彙を参照する葉部品（DetectionPin /
// ChoiceStrip / RequirementsScrollList / ResultView 等）が 6 箇所を超え、中間層
// （ConversationShell 等）はモードに関心が無いため。モードはセッション中不変の値で、
// 再レンダー特性も問題にならない。

import { createContext, useContext } from "react";

/** SessionMeta.interview_mode と同じ語彙（apps/api ProductJoinResponse.interview_mode）。 */
export type InterviewMode = "developer" | "end_user";

const InterviewModeContext = createContext<InterviewMode>("developer");

/** 会話画面ツリーへモードを供給する（/join のゲスト・end_user 入場が使う）。 */
export const InterviewModeProvider = InterviewModeContext.Provider;

/** 現在のインタビュー・モード。Provider が無ければ developer（従来表示）。 */
export function useInterviewMode(): InterviewMode {
  return useContext(InterviewModeContext);
}
