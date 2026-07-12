"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Diamond,
  Paperclip,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { HelpIcon, Logo, RecPill } from "@/components/sanba";
import type { MiniStatus } from "@/lib/realtime/selectors";

export type ShellTab = "history" | "files" | "scroll";

const TAB_ORDER: ShellTab[] = ["history", "files", "scroll"];
const TAB_LABELS: Record<ShellTab, string> = {
  history: "会話履歴",
  files: "参考資料",
  scroll: "要件一覧",
};

export interface ConversationShellProps {
  mini: MiniStatus;
  recording?: boolean;
  elapsed?: string;
  onEnd?: () => void;
  defaultTab?: ShellTab;
  tab?: ShellTab;
  onTabChange?: (tab: ShellTab) => void;
  onUnresolvedJump?: () => void;
  hideMaterials?: boolean;
  review?: boolean;
  onBackToResult?: () => void;
  tabs: Record<ShellTab, ReactNode>;
  choicePin?: ReactNode;
  bottomBar?: ReactNode;
  voiceStatus?: ReactNode;
  sidePanel?: ReactNode;
}

export function ConversationShell({
  mini,
  recording = true,
  elapsed = "0:00",
  onEnd,
  defaultTab = "history",
  tab: controlledTab,
  onTabChange,
  onUnresolvedJump,
  hideMaterials = false,
  review = false,
  onBackToResult,
  tabs,
  choicePin,
  bottomBar,
  voiceStatus,
  sidePanel,
}: ConversationShellProps) {
  const [internalTab, setInternalTab] = useState<ShellTab>(defaultTab);
  const [minimized, setMinimized] = useState(false);
  const tabOrder = hideMaterials ? TAB_ORDER.filter((t) => t !== "files") : TAB_ORDER;
  const isControlled = controlledTab !== undefined;
  const tab = isControlled ? controlledTab : internalTab;
  const setTab = (next: ShellTab) => {
    if (!isControlled) setInternalTab(next);
    onTabChange?.(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header
        className={`flex items-center gap-2 border-b border-sanba-border-strong bg-sanba-surface-strong px-4 ${
          minimized ? "py-1" : "pb-2 pt-2"
        }`}
      >
        {!minimized && (
          <>
            <Logo size="sm" wordmark={false} className="shrink-0" />
            <span aria-hidden className="h-4 w-px shrink-0 bg-sanba-border-strong" />
          </>
        )}
        <h1
          className={`font-bold text-sanba-cream ${minimized ? "text-[13px]" : "text-[15px]"}`}
        >
          会話
        </h1>
        <span className="flex-1" />
        {review ? (
          <button
            type="button"
            aria-label="結果に戻る"
            onClick={onBackToResult}
            className="inline-flex items-center gap-[2px] rounded-full border border-sanba-border bg-sanba-surface px-3 py-[5px] text-[12px] font-bold text-sanba-gold-text"
          >
            <ChevronLeft size={13} aria-hidden /> 結果へ戻る
          </button>
        ) : (
          <>
            {recording && <RecPill>{elapsed}</RecPill>}
            <button
              type="button"
              aria-label="会話を終了"
              onClick={onEnd}
              disabled={!onEnd}
              className="flex size-7 items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-[13px] text-sanba-muted disabled:opacity-40"
            >
              <Square size={13} aria-hidden />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label={minimized ? "ヘッダーを開く" : "ヘッダーを最小化"}
          aria-expanded={!minimized}
          onClick={() => setMinimized((m) => !m)}
          className="flex size-7 items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-sanba-muted"
        >
          {minimized ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidePanel && (
          <aside
            aria-label="サンバの状態"
            className="hidden shrink-0 flex-col items-center justify-center gap-6 border-r border-sanba-border px-8 lg:flex lg:w-[340px] xl:w-[420px]"
          >
            {sidePanel}
          </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!minimized && (
      <div className="px-4 pb-[6px] pt-2">
        <div
          aria-label="状況"
          className="flex items-center gap-2 rounded-[10px] border border-sanba-border bg-sanba-surface px-3 py-2 text-[11.5px]"
        >
          <button
            type="button"
            onClick={() => setTab("scroll")}
            className="inline-flex items-center gap-1 font-bold text-sanba-gold-text"
          >
            <Diamond size={12} aria-hidden /> 要件 {mini.requirements}
          </button>
          <span className="text-sanba-border-strong">・</span>
          <button
            type="button"
            onClick={() => {
              setTab("scroll");
              onUnresolvedJump?.();
            }}
            className="inline-flex items-center gap-1 font-bold text-sanba-caution"
          >
            <TriangleAlert size={12} aria-hidden /> 未解消 {mini.unresolved}
          </button>
          <HelpIcon term="未解消" />
          {!hideMaterials && (
            <>
              <span className="text-sanba-border-strong">・</span>
              <button
                type="button"
                onClick={() => setTab("files")}
                className="inline-flex items-center gap-1 text-sanba-muted"
              >
                <Paperclip size={12} aria-hidden /> 参考資料 {mini.materials}
                {mini.analyzing ? "（解析中）" : ""}
              </button>
            </>
          )}
          <span className="flex-1" />
          <span aria-hidden className="text-sanba-gold-text">
            <ChevronRight size={13} />
          </span>
        </div>
      </div>
      )}

      <div
        role="tablist"
        aria-label="情報タブ"
        className="flex gap-5 border-b border-sanba-border px-4"
      >
        {tabOrder.map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(k)}
              className={`flex flex-col items-center gap-1.5 pt-1.5 text-[13px] ${
                active ? "font-bold text-sanba-gold-text" : "text-sanba-muted"
              }`}
            >
              <span>{TAB_LABELS[k]}</span>
              <span className={`h-[2px] w-full ${active ? "bg-sanba-gold" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      <main role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tabs[tab]}
      </main>

      {!review && choicePin}
      {!review && voiceStatus && (
        <div
          className={`flex justify-center border-b border-sanba-border bg-sanba-surface-strong px-4 py-1.5 ${
            sidePanel ? "lg:hidden" : ""
          }`}
        >
          {voiceStatus}
        </div>
      )}
      {!review && bottomBar}
        </div>
      </div>
    </div>
  );
}
