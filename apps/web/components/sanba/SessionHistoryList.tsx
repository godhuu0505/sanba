import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { ListRow } from "./ListRow";

/**
 * 01 ホーム「過去の要件を見る」履歴セクション（Figma 正本 40:2 / 子 99:3・99:5）。
 * 見出し＋履歴リスト（標題＋日付＋末尾 ›）をまとめて描画する領域コンポーネント。
 * データ取得 API は別途（issue #215）。`items` を props で受け、空配列のときは空状態の
 * 文言だけを出す（遷移要素は出さない）。行は既存 ListRow を再利用する。
 */
export interface SessionHistoryItem {
  id: string;
  /** 要件の標題（例: 新機能要件定義）。 */
  title: string;
  /** 表示用の日付文字列（例: 2024/06/20）。整形は呼び出し側 or 別 issue。 */
  date: string;
}

export interface SessionHistoryListProps extends React.HTMLAttributes<HTMLElement> {
  items: SessionHistoryItem[];
  /** 行の遷移先。既定は過去要件の絵巻閲覧画面 /sessions/{id}。 */
  hrefFor?: (id: string) => string;
  /** 空状態の文言。 */
  emptyText?: string;
}

const HEADING_ID = "session-history-heading";

export const SessionHistoryList = React.forwardRef<HTMLElement, SessionHistoryListProps>(
  (
    {
      className,
      items,
      hrefFor = (id) => `/sessions/${encodeURIComponent(id)}`,
      emptyText = "過去の要件はまだございません。壁打ちを始めると、ここに残ります。",
      ...props
    },
    ref,
  ) => {
    return (
      <section
        ref={ref as never}
        aria-labelledby={HEADING_ID}
        className={cn("flex w-full flex-col gap-[10px]", className)}
        {...props}
      >
        <h2 id={HEADING_ID} className="text-[13px] font-bold text-[var(--sanba-muted)]">
          過去の要件を見る
        </h2>
        {items.length === 0 ? (
          // 空状態。棒人間はホームのヒーロー側が担うため出さない（ADR-0025「1画面1体まで」）。
          <div className="flex items-center rounded-[12px] border border-dashed border-[var(--sanba-border-strong)] bg-[var(--sanba-surface)] px-[14px] py-[12px]">
            <p className="text-[13px] leading-relaxed text-[var(--sanba-muted)]">{emptyText}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-[8px]">
            {items.map((item) => (
              <li key={item.id}>
                {/* ListRow は内部で複数の子（標題＋シェブロン）を描くため asChild(Slot) は使えない。
                    SessionRow と同様に、Link でラップして行全体をリンク化する。末尾 › は色のみに
                    依存しない遷移手掛かり、min-h-[44px] でタップ領域 44px 以上を確保する。 */}
                <Link
                  href={hrefFor(item.id)}
                  aria-label={`${item.title}（${item.date}）`}
                  className="block rounded-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sanba-gold)]"
                >
                  <ListRow className="min-h-[44px]" title={item.title} subtitle={item.date} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  },
);
SessionHistoryList.displayName = "SessionHistoryList";
