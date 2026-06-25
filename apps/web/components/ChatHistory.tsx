"use client";

// 会話履歴タブの本文。SessionState.transcript を吹き出しで描く。
// 仕様: docs/design/conversation-experience.md §2（会話履歴）/ screens/04-conversation.md。

import type { TranscriptLine } from "@/lib/realtime/store";

import { ChatBubble } from "./sanba/ChatBubble";

export interface ChatHistoryProps {
  transcript: TranscriptLine[];
}

export function ChatHistory({ transcript }: ChatHistoryProps) {
  if (transcript.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        <p className="text-center text-[13px] text-[var(--sanba-muted)]">🎙 話しかけてください</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {transcript.map((line) => {
        // role が "user" の発話を参加者、それ以外（assistant/各専門家）を SANBA 側とみなす。
        const author = line.role === "user" ? "user" : "agent";
        return (
          <ChatBubble key={line.utterance_id} author={author}>
            {line.text}
            {!line.final && (
              <span className="ml-1 align-middle text-[11px] font-bold text-[var(--sanba-speak)]">
                ‖ 認識中…
              </span>
            )}
          </ChatBubble>
        );
      })}
    </div>
  );
}
