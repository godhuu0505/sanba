"use client";

import { LoaderCircle, Mic } from "lucide-react";

import type { TranscriptLine } from "@/lib/realtime/store";

import { ChatBubble } from "./sanba/ChatBubble";

const AGENT_ROLES = new Set(["assistant", "agent", "sanba"]);

export interface ChatHistoryProps {
  transcript: TranscriptLine[];
}

export function ChatHistory({ transcript }: ChatHistoryProps) {
  if (transcript.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        <p className="inline-flex items-center justify-center gap-1.5 text-center text-[13px] text-sanba-muted">
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
              <span className="ml-1 inline-flex items-center gap-1 align-middle text-[11px] font-bold text-sanba-speak-text">
                <LoaderCircle size={11} aria-hidden className="animate-spin" /> 文字起こし中…
              </span>
            )}
          </ChatBubble>
        );
      })}
    </div>
  );
}
