"use client";

// 会話履歴タブの本文。SessionState.transcript を吹き出しで描く。
// 仕様: docs/design/conversation-experience.md §2（会話履歴）/ screens/04-conversation.md。

import { Mic } from "lucide-react";

import type { TranscriptLine } from "@/lib/realtime/store";

import { ChatBubble } from "./sanba/ChatBubble";

// SANBA（エージェント）側の role 集合。これ以外（participant / customer / pm 等）は参加者扱い。
// 実データの参加者ロールは "participant"（apps/agent main.py）/ "customer" / "pm"（fixtures）で
// "user" は来ないため、user リテラル一致ではなくエージェント側を allowlist して判定する。
const AGENT_ROLES = new Set(["assistant", "agent", "sanba"]);

export interface ChatHistoryProps {
  transcript: TranscriptLine[];
}

export function ChatHistory({ transcript }: ChatHistoryProps) {
  if (transcript.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        <p className="inline-flex items-center justify-center gap-1.5 text-center text-[13px] text-[var(--sanba-muted)]">
          <Mic size={15} aria-hidden /> 話しかけてください
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {transcript.map((line) => {
        const author = AGENT_ROLES.has(line.role) ? "agent" : "user";
        return (
          <ChatBubble key={line.utterance_id} author={author}>
            {line.text}
            {!line.final && (
              <span className="ml-1 align-middle text-[11px] font-bold text-[var(--sanba-speak-text)]">
                ‖ 認識中…
              </span>
            )}
          </ChatBubble>
        );
      })}
    </div>
  );
}
