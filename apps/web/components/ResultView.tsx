"use client";

// 08 結果（要件産婆結果）。確定要件の受け渡し。
// 仕様: docs/reference/conversation-experience.md §7 / screens/08-result.md / Figma 144:86。
// 画面で確認＝必須。PDF/Drive/Issue 出力＝任意（ハンドラがあるものだけ出す）。

import { Check, ChevronRight, CircleDot, Cloud, FileText, type LucideIcon } from "lucide-react";

import { Button, Figure } from "@/components/sanba";
import { useInterviewMode } from "../lib/interviewMode";
import { SideMenu } from "./SideMenu";
import { categoryPresentation, priorityLabel } from "../lib/realtime/mapping";
import type { Priority, Requirement } from "../lib/realtime/types";

/**
 * artifact の href として安全な scheme か（http/https のみ許可）。
 * artifacts は LiveKit データチャネル（session.completed）由来で送信者・payload を信頼できないため、
 * `javascript:` / `data:` 等を href に渡すとクリックで実行され得る。表示前に弾く。
 */
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** プレビューで先に出す優先度（Figma 08：Must/Should を優先表示）。 */
const PREVIEW_PRIORITIES: readonly Priority[] = ["must", "should"];
/** 各優先度セクションでプレビューに出す最大件数。超過は「ほか N 件 ›」へ畳む。 */
const SECTION_LIMIT = 3;

export interface ResultViewProps {
  confirmedCount: number;
  /** Must/Should/Could の内訳（任意）。 */
  breakdown?: { must: number; should: number; could: number };
  /**
   * プレビューに出す確定要件（status==="confirmed" のもの／selectConfirmedRequirements 由来）。
   * 確定判定は呼び出し側のセレクタに一元化し、本コンポーネントは表示のみを担う。
   * 未指定（テスト等）ならプレビューは出さず件数サマリのみ。
   */
  requirements?: Requirement[];
  /** 未解消を残したまま終了した暫定結果か（07 の onForceEnd 経路）。確定済みと区別する。 */
  provisional?: boolean;
  /**
   * session.completed のサーバ集計（届いていれば表示）。確定件数と異なり、会話全体の成果
   * （矛盾解消・抜け検知・Issue 起票）を agent 側の値で示す。ローカル再集計しない。
   */
  summary?: { contradictions_resolved: number; gaps_found: number; issues_created: number } | null;
  /** 生成物リンク（session.completed.artifacts）。PDF/Drive/Issue などの成果物 URL。 */
  artifacts?: { kind: string; url: string }[];
  /** この絵巻を画面で確認する（既定動線・必須）。 */
  onView: () => void;
  /** 新しい問答を始める。 */
  onRestart: () => void;
  /** 任意出力。未指定のものはボタンを出さない。 */
  onExportPdf?: () => void;
  onExportDrive?: () => void;
  onExportIssue?: () => void;
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
}: ResultViewProps) {
  // end_user モード（FR-2.4 / ADR-0032）: MoSCoW の内訳文字列（Must n ・ Should n ...）は
  // 内部分類の露出になるため出さない。セクション見出しは priorityLabel(mode) が利用者の
  // 言葉に差し替える。summary の「矛盾解消/抜け検知/Issue 起票」も開発語彙なので出さない。
  const interviewMode = useInterviewMode();
  const endUser = interviewMode === "end_user";
  // 信頼できない URL scheme（javascript: 等）は表示しない（XSS 防止）。
  const artifactLinks = (artifacts ?? []).filter((a) => isSafeHttpUrl(a.url));
  const outputs: { label: string; icon: LucideIcon; handler?: () => void }[] = [
    { label: "PDF", icon: FileText, handler: onExportPdf },
    { label: "Drive", icon: Cloud, handler: onExportDrive },
    { label: "Issue", icon: CircleDot, handler: onExportIssue },
  ];
  const available = outputs.filter((o) => o.handler);

  // 確定要件のプレビュー（Figma 144:86）。Must/Should を優先表示し、各セクション SECTION_LIMIT 件まで。
  // それ以外（Could/Won't や上限超過分）は「ほか N 件 ›」に畳んで全文（onView）へ誘導する。
  // 空の優先度セクションは描画しない。
  const confirmedReqs = requirements ?? [];
  const previewGroups = PREVIEW_PRIORITIES.map((priority) => ({
    priority,
    items: confirmedReqs.filter((r) => r.priority === priority).slice(0, SECTION_LIMIT),
  })).filter((g) => g.items.length > 0);
  const previewedCount = previewGroups.reduce((n, g) => n + g.items.length, 0);
  const overflowCount = confirmedReqs.length - previewedCount;

  return (
    <div className="flex h-full flex-col items-center px-4 pb-4 pt-5">
      {/* サイドメニュー（結果画面からホーム/準備/アプリ管理へ横断遷移）。end_user は
          開発者向け導線（アプリ管理）を見せない（ADR-0032 の語彙方針と同じ倒し方）。 */}
      {!endUser && (
        <div className="flex w-full justify-start">
          <SideMenu />
        </div>
      )}
      {/* 結果の主役はサンバさん（ADR-0033 §6）。確定＝両手を挙げるひらめき、暫定＝書き留める姿。
          産章は胸のバッジに宿り、静止した金章から「動く産婆さん」へ。意味は下の見出しが読み上げる
          ので figure は装飾（label 無し＝aria-hidden・reduced-motion 静止）。 */}
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
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={o.handler}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-sanba-border bg-sanba-surface py-[11px] text-[11.5px] font-bold text-sanba-muted"
                >
                  <Icon size={14} aria-hidden /> {o.label}
                </button>
              );
            })}
          </div>
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
