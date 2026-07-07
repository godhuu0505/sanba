"use client";

import { Check, ChevronRight, CircleDot, Cloud, FileText, type LucideIcon } from "lucide-react";

import { Button, Figure } from "@/components/sanba";
import { useInterviewMode } from "../lib/interviewMode";
import { SideMenu } from "./SideMenu";
import { categoryPresentation, priorityLabel } from "../lib/realtime/mapping";
import type { Priority, Requirement } from "../lib/realtime/types";

function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type IssueExportStatus =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; url?: string }
  | { status: "error"; reason?: string };

function issueExportReasonText(reason?: string): string {
  switch (reason) {
    case "github connector disabled":
      return "GitHub 連携が無効のため起票できませんでした。";
    case "github repo not allowed":
      return "許可されていないリポジトリのため起票できませんでした。";
    default:
      return "起票に失敗しました。時間をおいて再度お試しください。";
  }
}

const PREVIEW_PRIORITIES: readonly Priority[] = ["must", "should"];
const SECTION_LIMIT = 3;

export interface ResultViewProps {
  confirmedCount: number;
  breakdown?: { must: number; should: number; could: number };
  requirements?: Requirement[];
  provisional?: boolean;
  summary?: { contradictions_resolved: number; gaps_found: number; issues_created: number } | null;
  artifacts?: { kind: string; url: string }[];
  onView: () => void;
  onRestart: () => void;
  onExportPdf?: () => void;
  onExportDrive?: () => void;
  onExportIssue?: () => void;
  issueExport?: IssueExportStatus;
}

export function ResultView({
  confirmedCount,
  breakdown,
  requirements,
  provisional = false,
  summary = null,
  artifacts,
  onView,
  onRestart,
  onExportPdf,
  onExportDrive,
  onExportIssue,
  issueExport = { status: "idle" },
}: ResultViewProps) {
  const interviewMode = useInterviewMode();
  const endUser = interviewMode === "end_user";
  const artifactLinks = (artifacts ?? []).filter((a) => isSafeHttpUrl(a.url));
  const outputs: { label: string; icon: LucideIcon; handler?: () => void }[] = [
    { label: "PDF", icon: FileText, handler: onExportPdf },
    { label: "Drive", icon: Cloud, handler: onExportDrive },
    { label: "Issue", icon: CircleDot, handler: onExportIssue },
  ];
  const available = outputs.filter((o) => o.handler);

  const confirmedReqs = requirements ?? [];
  const previewGroups = PREVIEW_PRIORITIES.map((priority) => ({
    priority,
    items: confirmedReqs.filter((r) => r.priority === priority).slice(0, SECTION_LIMIT),
  })).filter((g) => g.items.length > 0);
  const previewedCount = previewGroups.reduce((n, g) => n + g.items.length, 0);
  const overflowCount = confirmedReqs.length - previewedCount;

  return (
    <div className="flex h-full flex-col items-center px-4 pb-4 pt-5">
      {!endUser && (
        <div className="flex w-full justify-start">
          <SideMenu />
        </div>
      )}
      <Figure state={provisional ? "writing" : "insight"} className="w-[84px]" />
      <p className="mt-[10px] text-center text-[18px] font-bold text-sanba-gold-text">
        {endUser
          ? provisional
            ? "ここまでのお話を書き留めました"
            : "お話の内容を整理できました"
          : provisional
            ? "暫定で書き留めました"
            : "オーレ！ 要件、産まれました"}
      </p>
      <p className="mt-1 text-center text-[12px] text-sanba-muted">
        {endUser ? "うかがった内容 " : provisional ? "暫定要件 " : "確定要件 "}
        {confirmedCount} 件
        {!endUser && breakdown
          ? `（Must ${breakdown.must} ・ Should ${breakdown.should} ・ Could ${breakdown.could}）`
          : ""}
        {provisional && !endUser ? " ・ 未確定を残したまま終了" : ""}
      </p>

      {summary && !endUser && (
        <p className="mt-[6px] text-center text-[11px] text-sanba-muted">
          矛盾解消 {summary.contradictions_resolved} ・ 抜け検知 {summary.gaps_found} ・ Issue 起票{" "}
          {summary.issues_created}
        </p>
      )}

      {(previewGroups.length > 0 || overflowCount > 0) && (
        <div
          role="group"
          aria-label="確定要件のプレビュー"
          className="mt-3 w-full space-y-3 overflow-y-auto"
        >
          {previewGroups.map((g) => (
            <div key={g.priority}>
              <h3 className="text-[10.5px] font-bold text-sanba-muted">
                {priorityLabel(g.priority, interviewMode)}
              </h3>
              <ul className="mt-[6px] space-y-[6px]">
                {g.items.map((r) => {
                  const cat = categoryPresentation(r.category, interviewMode);
                  return (
                    <li
                      key={r.id}
                      className="flex items-start gap-2 rounded-[11px] border border-sanba-border bg-sanba-surface px-3 py-[9px]"
                    >
                      <span
                        aria-hidden
                        className="mt-[2px] shrink-0"
                        style={{ color: cat.color }}
                      >
                        <cat.Icon size={12} />
                      </span>
                      <span className="sr-only">{cat.ariaLabel}</span>
                      <span className="flex-1 text-[12.5px] leading-[1.5] text-sanba-ink">
                        {r.statement}
                      </span>
                      <span aria-hidden className="mt-[1px] text-sanba-gold-text">
                        <Check size={12} />
                      </span>
                      <span className="sr-only">確定済み</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {overflowCount > 0 && (
            <button
              type="button"
              onClick={onView}
              className="inline-flex items-center gap-[2px] text-[11.5px] font-bold text-sanba-gold-text"
            >
              ほか {overflowCount} 件 ・ タップで全文 <ChevronRight size={12} aria-hidden />
            </button>
          )}
        </div>
      )}

      {artifactLinks.length > 0 && (
        <div className="mt-[10px] flex w-full flex-col gap-[6px]">
          {artifactLinks.map((a) => (
            <a
              key={`${a.kind}:${a.url}`}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[11px] border border-sanba-border bg-sanba-surface px-3 py-[10px] text-center text-[11.5px] font-bold text-sanba-gold-text"
            >
              {a.kind} を開く
            </a>
          ))}
        </div>
      )}

      <div className="flex-1" />

      <Button
        variant="gold"
        size="lg"
        block
        onClick={onView}
        aria-label="この絵巻を画面で確認する（確定要件の全文）"
      >
        <span className="inline-flex items-center justify-center gap-1">
          この絵巻を画面で確認する <ChevronRight size={15} aria-hidden />
        </span>
      </Button>

      {available.length > 0 && (
        <>
          <p className="mt-2 self-start text-[10.5px] font-bold text-sanba-muted">書き出す（任意）</p>
          <div className="mt-[6px] flex w-full gap-2">
            {available.map((o) => {
              const Icon = o.icon;
              const busy = o.label === "Issue" && issueExport.status === "pending";
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={o.handler}
                  disabled={busy}
                  aria-busy={busy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-sanba-border bg-sanba-surface py-[11px] text-[11.5px] font-bold text-sanba-muted disabled:opacity-60"
                >
                  <Icon size={14} aria-hidden /> {busy ? "起票中…" : o.label}
                </button>
              );
            })}
          </div>
          {onExportIssue && issueExport.status !== "idle" && issueExport.status !== "pending" && (
            <div className="mt-[6px] w-full" role="status" aria-live="polite">
              {issueExport.status === "done" ? (
                issueExport.url && isSafeHttpUrl(issueExport.url) ? (
                  <a
                    href={issueExport.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-[11px] border border-sanba-border bg-sanba-surface px-3 py-[10px] text-center text-[11.5px] font-bold text-sanba-gold-text"
                  >
                    起票した Issue を開く ↗
                  </a>
                ) : (
                  <p className="text-center text-[11px] font-bold text-sanba-gold-text">
                    Issue を起票しました
                  </p>
                )
              ) : (
                <p className="text-center text-[11px] font-bold text-red-500">
                  {issueExportReasonText(issueExport.reason)}
                </p>
              )}
            </div>
          )}
        </>
      )}

      <button
        type="button"
        onClick={onRestart}
        className="mt-[10px] text-[12px] font-bold text-sanba-gold-text"
      >
        新しい問答を始める
      </button>
    </div>
  );
}
