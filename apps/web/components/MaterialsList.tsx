"use client";

// 参考資料タブの本文。投入済み素材を一覧し、解析進捗をインライン表示する。
// 仕様: docs/design/conversation-experience.md §3,§6 / screens/05-materials.md。
// 解析はバックグラウンドで進む（会話を止めない）ため、各行に状態（アップロード/解析中/完了/失敗）を出す。

// 素材ビューモデルは共有セレクタ層（selectMaterials）に寄せ、ここでは再エクスポートのみ。
import { useEffect, useState } from "react";

import type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

import { MaterialCancelDialog } from "./MaterialCancelDialog";

export type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

export interface MaterialsListProps {
  items: MaterialItem[];
  /** 「＋ 素材を追加」押下（手段選択へ）。 */
  onAdd: () => void;
  /** 失敗行の再試行。 */
  onRetry?: (id: string) => void;
  /**
   * 解析/アップロード中の素材を中断する（#219）。確定すると当該素材を破棄する。
   * 未指定なら「✕ 中断」導線を出さない（破棄できない文脈で偽ボタンを作らない）。
   */
  onCancel?: (id: string) => void;
  /**
   * tempId→asset_id の一意対応（#219）。アップロード成功で行 id が差し替わったとき、確認中の
   * 対象を表示名ではなく一意 id で追跡するために使う（同名素材の取り違え防止・Codex P2）。
   */
  aliases?: ReadonlyMap<string, string>;
}

const STATUS_LABEL: Record<Exclude<MaterialStatus, "done" | "failed" | "cancelled">, string> = {
  uploading: "アップロード中",
  analyzing: "解析中",
};

export function MaterialsList({ items, onAdd, onRetry, onCancel, aliases }: MaterialsListProps) {
  // 中断確認ダイアログの対象素材（null=閉）。確定で onCancel(id) を呼ぶ（#219 / Figma 222:2）。
  const [cancelTarget, setCancelTarget] = useState<MaterialItem | null>(null);

  // 確認ダイアログを開いた後に対象が「中断可能でなくなった」ら自動で閉じる（Codex P2）。
  // 画像はアップロード成功時点でサーバ索引（grounding）まで完了し、行は done になる。完了済み
  // （サーバ反映済み）素材をクライアントだけで「破棄」したと見せないため、done/失敗/消滅で無効化する。
  // 一方、動画はアップロード成功で行 id が local:* → asset_id に差し替わっても status は analyzing の
  // ままで中断可能なので、閉じてはいけない。id 差し替えは一意対応（aliases: tempId→asset_id）で
  // 解決して追跡する（表示名は同名素材で衝突し取り違えるため使わない・Codex P2）。
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
      <button
        type="button"
        onClick={onAdd}
        className="rounded-[12px] border border-dashed border-[var(--sanba-frame)] bg-[#1b140b] px-3 py-[13px] text-[12.5px] font-bold text-[var(--sanba-gold-text)]"
      >
        ＋ 素材を追加（カメラ・アップロード・画面共有）
      </button>

      {items.length === 0 ? (
        <p className="px-1 py-4 text-center text-[12.5px] text-[var(--sanba-muted)]">
          まだありません。資料を追加すると、ここに解析状況が出ます。
        </p>
      ) : (
        items.map((it) => {
          return (
            <div
              key={it.id}
              aria-label={`資料 ${it.name}`}
              className="flex flex-col gap-[6px] rounded-[12px] border border-[var(--sanba-border)] bg-[#1b140b] px-3 py-[11px]"
            >
              <span className="text-[13px] font-bold text-[var(--sanba-cream)]">{it.name}</span>

              {it.status === "done" && (
                <span className="text-[11px] font-bold text-[var(--sanba-speak)]">
                  ✓ 解析済{typeof it.extracted === "number" ? ` ・ 要件 ${it.extracted} 件を抽出` : ""}
                </span>
              )}

              {(it.status === "uploading" || it.status === "analyzing") && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--sanba-muted)]">{STATUS_LABEL[it.status]}</span>
                  <div
                    role="progressbar"
                    aria-valuenow={it.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-[5px] flex-1 overflow-hidden rounded-full bg-[var(--sanba-surface)]"
                  >
                    <div className="h-full sanba-gold-gradient" style={{ width: `${it.pct}%` }} />
                  </div>
                  <span className="text-[11px] font-bold text-[var(--sanba-gold-text)]">{it.pct}%</span>
                  {/* ✕ 中断（#219 / Figma 136:14・135:80）。押下で破棄確認ダイアログを開く。 */}
                  {onCancel && (
                    <button
                      type="button"
                      aria-label={`${it.name} の解析を中断`}
                      onClick={() => setCancelTarget(it)}
                      className="rounded-full border border-[var(--sanba-frame)] px-[9px] py-[3px] text-[11px] font-bold text-[var(--sanba-muted)]"
                    >
                      ✕ 中断
                    </button>
                  )}
                </div>
              )}

              {it.status === "failed" && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-[var(--sanba-rec)]">アップロード/解析に失敗</span>
                  {onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(it.id)}
                      className="rounded-full border border-[var(--sanba-frame)] px-[9px] py-[3px] text-[11px] font-bold text-[var(--sanba-gold-text)]"
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

      {/* 中断確認（#219）。続ける=閉じる、中断する=確定で当該素材を破棄する（onCancel）。
          対象が完了（done）等で in-flight でなくなったら liveTarget が外れ、確認は出さない（Codex P2）。 */}
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
