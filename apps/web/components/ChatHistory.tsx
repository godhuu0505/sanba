"use client";

import { AlertTriangle, Check, FileText, LoaderCircle, Mic, Package, Slash } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { useInterviewMode } from "@/lib/interviewMode";
import type { ContextProgressState, TranscriptLine } from "@/lib/realtime/store";
import type { MaterialItem } from "@/lib/realtime/selectors";
import type { SessionPhase } from "@/lib/realtime/types";

import { ChatBubble } from "./sanba/ChatBubble";

const AGENT_ROLES = new Set(["assistant", "agent", "sanba"]);

const STICK_THRESHOLD_PX = 120;

function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}

export interface ChatHistoryProps {
  transcript: TranscriptLine[];
  contextProgress?: ContextProgressState[];
  materials?: MaterialItem[];
  userPicture?: string;
  phase?: SessionPhase;
  agentSpeaking?: boolean;
}

function SetupBubble({
  icon,
  tone,
  title,
  detail,
  pct,
}: {
  icon: React.ReactNode;
  tone: "done" | "running" | "failed";
  title: string;
  detail?: string;
  pct?: number;
}) {
  const toneText =
    tone === "done"
      ? "text-sanba-speak-text"
      : tone === "failed"
        ? "text-sanba-rec-text"
        : "text-sanba-gold-text";
  return (
    <div
      className="flex w-full items-start gap-[8px]"
      aria-label="セッションの準備"
    >
      <span className="size-[32px] shrink-0" aria-hidden />
      <div className="max-w-[85%] rounded-[12px] border border-sanba-border bg-sanba-surface-strong px-[12px] py-[9px]">
        <p className={`flex items-center gap-1.5 text-[12px] font-bold ${toneText}`}>
          <span aria-hidden>{icon}</span>
          {title}
        </p>
        {typeof pct === "number" && tone === "running" && (
          <div
            className="mt-[7px] h-[6px] w-full overflow-hidden rounded-full bg-sanba-surface"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${title} の進捗`}
          >
            <div
              className="h-full rounded-full bg-sanba-gold transition-[width] duration-500"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
        )}
        {detail && <p className="mt-[4px] text-[10.5px] text-sanba-muted">{detail}</p>}
      </div>
    </div>
  );
}

function ContextBubble({ item }: { item: ContextProgressState }) {
  const done = item.stage === "done" || item.stage === "reused";
  const failed = item.stage === "failed";
  const running = item.stage === "running";
  const tone = done ? "done" : failed ? "failed" : "running";
  const icon = done ? (
    <Check size={13} />
  ) : failed ? (
    <AlertTriangle size={13} />
  ) : (
    <LoaderCircle size={13} className="animate-spin" />
  );
  const prefix = item.source === "repo" ? <Package size={13} /> : <FileText size={13} />;
  const title =
    item.label ||
    (item.source === "repo" ? "ソースコード" : item.source === "materials" ? "参考資料" : "ゴール");
  return (
    <SetupBubble
      icon={
        <span className="inline-flex items-center gap-1">
          {prefix}
          {icon}
        </span>
      }
      tone={tone}
      title={title}
      detail={item.detail || undefined}
      pct={running ? 50 : undefined}
    />
  );
}

function MaterialBubble({ item }: { item: MaterialItem }) {
  if (item.status === "cancelled" || item.status === "uploading") return null;
  const done = item.status === "done";
  const failed = item.status === "failed";
  const tone = done ? "done" : failed ? "failed" : "running";
  const icon = done ? (
    <Check size={13} />
  ) : failed ? (
    <AlertTriangle size={13} />
  ) : (
    <LoaderCircle size={13} className="animate-spin" />
  );
  const detail = done
    ? item.extracted
      ? `解析済み · 抽出 ${item.extracted} 件`
      : "解析済み"
    : failed
      ? "解析に失敗しました"
      : `解析中… ${item.pct}%`;
  return (
    <SetupBubble
      icon={icon}
      tone={tone}
      title={item.name}
      detail={detail}
      pct={done || failed ? undefined : item.pct}
    />
  );
}

export function ChatHistory({
  transcript,
  contextProgress = [],
  materials = [],
  userPicture,
  phase,
  agentSpeaking,
}: ChatHistoryProps) {
  const endUser = useInterviewMode() === "end_user";
  const tail = transcript.at(-1);
  const showThinking =
    phase === "deliberating" &&
    !agentSpeaking &&
    (!tail || !AGENT_ROLES.has(tail.role) || tail.final);
  const setupItems = [...contextProgress];
  const materialBubbles = materials.filter(
    (m) => m.status !== "cancelled" && m.status !== "uploading",
  );
  const hasSetup = setupItems.length > 0 || materialBubbles.length > 0 || endUser;

  const endRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const detachRef = useRef<(() => void) | null>(null);
  const lastLine = transcript[transcript.length - 1];

  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    endRef.current = node;
    detachRef.current?.();
    detachRef.current = null;
    const scroller = node ? getScrollParent(node) : null;
    if (!scroller) return;
    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      stickRef.current = distance <= STICK_THRESHOLD_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    detachRef.current = () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => () => detachRef.current?.(), []);

  useEffect(() => {
    if (stickRef.current) {
      endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
    }
  }, [transcript.length, lastLine?.text, lastLine?.final]);

  if (transcript.length === 0 && !hasSetup) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-8">
        {showThinking ? (
          <p className="inline-flex items-center justify-center gap-1.5 text-center text-[13px] font-bold text-sanba-speak-text">
            <LoaderCircle size={15} aria-hidden className="animate-spin" /> 考え中…
          </p>
        ) : (
          <p className="inline-flex items-center justify-center gap-1.5 text-center text-[13px] text-sanba-muted">
            <Mic size={15} aria-hidden /> 話しかけてください
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {endUser && (
        <SetupBubble
          icon={
            <span className="inline-flex items-center gap-1">
              <Package size={13} />
              <Slash size={13} />
            </span>
          }
          tone="done"
          title="資料/リポジトリ解析：対象外"
          detail="利用者向けセッションのため、内部資料/リポジトリの解析は行いません。"
        />
      )}
      {setupItems.map((c) => (
        <ContextBubble key={`ctx:${c.source}`} item={c} />
      ))}
      {materialBubbles.map((m) => (
        <MaterialBubble key={`mat:${m.id}`} item={m} />
      ))}
      {transcript.map((line) => {
        const author = AGENT_ROLES.has(line.role) ? "agent" : "user";
        return (
          <ChatBubble
            key={line.utterance_id}
            author={author}
            avatarImageUrl={author === "user" ? userPicture : undefined}
          >
            {line.text}
            {!line.final && (
              <span className="ml-1 inline-flex items-center gap-1 align-middle text-[11px] font-bold text-sanba-speak-text">
                <LoaderCircle size={11} aria-hidden className="animate-spin" /> 文字起こし中…
              </span>
            )}
          </ChatBubble>
        );
      })}
      {showThinking && (
        <ChatBubble author="agent">
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-sanba-speak-text">
            <LoaderCircle size={11} aria-hidden className="animate-spin" /> 考え中…
          </span>
        </ChatBubble>
      )}
      <div ref={setSentinel} aria-hidden />
    </div>
  );
}
