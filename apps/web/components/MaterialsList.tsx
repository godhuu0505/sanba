"use client";

import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";

import { HelpIcon } from "@/components/sanba";
import type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

import { MaterialCancelDialog } from "./MaterialCancelDialog";

export type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

export interface MaterialsListProps {
  items: MaterialItem[];
  onAdd?: () => void;
  onRetry?: (id: string) => void;
  onOpenDetail?: (id: string) => void;
  onCancel?: (id: string) => void;
  aliases?: ReadonlyMap<string, string>;
}

const STATUS_LABEL: Record<Exclude<MaterialStatus, "done" | "failed" | "cancelled">, string> = {
  uploading: "アップロード中",
  analyzing: "解析中",
};

const ROW_CLASS =
  "flex flex-col gap-[6px] rounded-[12px] border border-sanba-border bg-sanba-surface px-3 py-[11px]";

export function MaterialsList({
  items,
  onAdd,
  onRetry,
  onOpenDetail,
  onCancel,
  aliases,
}: MaterialsListProps) {
  const [cancelTarget, setCancelTarget] = useState<MaterialItem | null>(null);

  const isInFlight = (m: MaterialItem) => m.status === "uploading" || m.status === "analyzing";
  const currentTargetId = cancelTarget
    ? (aliases?.get(cancelTarget.id) ?? cancelTarget.id)
    : undefined;
  const liveTarget = currentTargetId
    ? items.find((m) => m.id === currentTargetId && isInFlight(m))
    : undefined;
  useEffect(() => {
    if (cancelTarget && !liveTarget) setCancelTarget(null);
  }, [cancelTarget, liveTarget]);

  return (
    <div className="flex flex-col gap-[10px] px-4 py-3">
      {onAdd && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-sanba-gold-deep bg-sanba-surface px-3 py-[13px] text-[12.5px] font-bold text-sanba-gold-text"
          >
            <Plus size={14} aria-hidden /> 参考資料を追加（カメラ・アップロード・画面共有）
          </button>
          <HelpIcon term="参考資料" />
        </div>
      )}

      {items.length === 0 ? (
        <p className="px-1 py-4 text-center text-[12.5px] text-sanba-muted">
          まだありません。参考資料を追加すると、ここに解析状況が出ます。
        </p>
      ) : (
        items.map((it) => {
          const openable = !!onOpenDetail && it.status === "done";

          const body = (
            <>
              <span className="text-[13px] font-bold text-sanba-cream">{it.name}</span>

              {it.status === "done" && (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-sanba-speak-text">
                  <Check size={13} aria-hidden /> 解析済
                  {typeof it.extracted === "number" ? ` ・ 要件 ${it.extracted} 件を抽出` : ""}
                </span>
              )}

              {(it.status === "uploading" || it.status === "analyzing") && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-sanba-muted">{STATUS_LABEL[it.status]}</span>
                  {it.status === "analyzing" && <HelpIcon term="解析" />}
                  <div
                    role="progressbar"
                    aria-valuenow={it.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-[5px] flex-1 overflow-hidden rounded-full bg-sanba-border"
                  >
                    <div className="h-full sanba-gold-gradient" style={{ width: `${it.pct}%` }} />
                  </div>
                  <span className="text-[11px] font-bold text-sanba-gold-text">{it.pct}%</span>
                  {onCancel && (
                    <button
                      type="button"
                      aria-label={`${it.name} の解析を中断`}
                      onClick={() => setCancelTarget(it)}
                      className="inline-flex items-center gap-1 rounded-full border border-sanba-frame px-[9px] py-[3px] text-[11px] font-bold text-sanba-muted"
                    >
                      <X size={12} aria-hidden /> 中断
                    </button>
                  )}
                </div>
              )}
            </>
          );

          if (openable) {
            return (
              <button
                key={it.id}
                type="button"
                aria-label={`参考資料 ${it.name} の詳細を開く`}
                onClick={() => onOpenDetail?.(it.id)}
                className={`${ROW_CLASS} text-left`}
              >
                {body}
              </button>
            );
          }

          return (
            <div key={it.id} aria-label={`参考資料 ${it.name}`} className={ROW_CLASS}>
              {body}

              {it.status === "failed" && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-sanba-rec-text">アップロード/解析に失敗</span>
                  {onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(it.id)}
                      className="rounded-full border border-sanba-frame px-[9px] py-[3px] text-[11px] font-bold text-sanba-gold-text"
                    >
                      再試行
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {onCancel && liveTarget && (
        <MaterialCancelDialog
          materialName={liveTarget.name}
          onContinue={() => setCancelTarget(null)}
          onConfirm={() => {
            onCancel(liveTarget.id);
            setCancelTarget(null);
          }}
        />
      )}
    </div>
  );
}
