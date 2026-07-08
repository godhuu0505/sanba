import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { ListRow } from "./ListRow";

export interface SessionHistoryItem {
  id: string;
  title: string;
  date: string;
  labels?: string[];
  exported?: boolean;
}

export interface SessionHistoryListProps extends React.HTMLAttributes<HTMLElement> {
  items: SessionHistoryItem[];
  hrefFor?: (id: string) => string;
  emptyText?: string;
}

const HEADING_ID = "session-history-heading";
const MAX_LABELS = 3;

export const SessionHistoryList = React.forwardRef<HTMLElement, SessionHistoryListProps>(
  (
    {
      className,
      items,
      hrefFor = (id) => `/results/${encodeURIComponent(id)}`,
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
        <h2 id={HEADING_ID} className="text-[13px] font-bold text-sanba-muted">
          過去の要件を見る
        </h2>
        {items.length === 0 ? (
          <div className="flex items-center rounded-[16px] border-[1.5px] border-dashed border-sanba-border-strong bg-sanba-surface px-[14px] py-[12px]">
            <p className="text-[13px] leading-relaxed text-sanba-muted">{emptyText}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-[8px]">
            {items.map((item) => {
              const labels = item.labels ?? [];
              const shown = labels.slice(0, MAX_LABELS);
              const overflow = labels.length - shown.length;
              const subtitle =
                (item.date ? `${item.date} ・ ${item.id}` : item.id) +
                (item.exported ? " ・ 起票済み ✓" : "");
              return (
                <li key={item.id}>
                  <Link
                    href={hrefFor(item.id)}
                    aria-label={`${item.title}（${item.date}・${item.id}）`}
                    className="block rounded-[16px] border-[1.5px] border-sanba-frame bg-sanba-surface transition-[box-shadow,transform] hover:shadow-[3px_3px_0_var(--sanba-shadow)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sanba-gold"
                  >
                    <ListRow
                      className="min-h-[44px] rounded-none border-0 bg-transparent hover:shadow-none"
                      title={item.title}
                      subtitle={subtitle}
                    />
                    {shown.length > 0 && (
                      <div className="flex flex-wrap gap-[4px] px-[14px] pb-[10px]">
                        {shown.map((l) => (
                          <span
                            key={l}
                            className="rounded-full border border-sanba-border bg-sanba-surface-strong px-[7px] py-[1px] text-[10px] text-sanba-muted"
                          >
                            {l}
                          </span>
                        ))}
                        {overflow > 0 && (
                          <span className="text-[10px] text-sanba-muted">+{overflow}</span>
                        )}
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  },
);
SessionHistoryList.displayName = "SessionHistoryList";
