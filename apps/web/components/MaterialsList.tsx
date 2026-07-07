"use client";

// 参考資料タブの本文。投入済み素材を一覧し、解析進捗をインライン表示する。
// 仕様: docs/reference/conversation-experience.md §3,§6 / screens/05-materials.md。
// 解析はバックグラウンドで進む（会話を止めない）ため、各行に状態（アップロード/解析中/完了/失敗）を出す。

// 素材ビューモデルは共有セレクタ層（selectMaterials）に寄せ、ここでは再エクスポートのみ。
import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";

import type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

import { MaterialCancelDialog } from "./MaterialCancelDialog";

export type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

export interface MaterialsListProps {
  items: MaterialItem[];
  /**
   * 「＋ 素材を追加」押下（手段選択へ）。未指定ならボタンを出さない
   * （セッション終了後の閲覧など、投入できない文脈で偽ボタンを作らない）。
   */
  onAdd?: () => void;
  /** 失敗行の再試行。 */
  onRetry?: (id: string) => void;
  /**
   * 素材行 → 05-1 詳細（抽出要件・言葉×画の矛盾）を開く。
   * 抽出要件/矛盾は解析完了（analysis.visual）で初めて確定するため、詳細導線は done 行のみ。
   * 解析中/アップロード中/失敗の行は出さない（中身が無い & 進捗バーを button に内包させない）。
   */
  onOpenDetail?: (id: string) => void;
  /**
   * 解析/アップロード中の素材を中断する。確定すると当該素材を破棄する。
   * 未指定なら「✕ 中断」導線を出さない（破棄できない文脈で偽ボタンを作らない）。
   */
  onCancel?: (id: string) => void;
  /**
   * tempId→asset_id の一意対応。アップロード成功で行 id が差し替わったとき、確認中の
   * 対象を表示名ではなく一意 id で追跡するために使う（同名素材の取り違え防止）。
   */
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
  // 中断確認ダイアログの対象素材（null=閉）。確定で onCancel(id) を呼ぶ（Figma 222:2）。
  const [cancelTarget, setCancelTarget] = useState<MaterialItem | null>(null);

  // 確認ダイアログを開いた後に対象が「中断可能でなくなった」ら自動で閉じる。
  // 画像はアップロード成功時点でサーバ索引（grounding）まで完了し、行は done になる。完了済み
  // （サーバ反映済み）素材をクライアントだけで「破棄」したと見せないため、done/失敗/消滅で無効化する。
  // 一方、動画はアップロード成功で行 id が local:* → asset_id に差し替わっても status は analyzing の
  // ままで中断可能なので、閉じてはいけない。id 差し替えは一意対応（aliases: tempId→asset_id）で
  // 解決して追跡する（表示名は同名素材で衝突し取り違えるため使わない）。
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
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-sanba-gold-deep bg-sanba-surface px-3 py-[13px] text-[12.5px] font-bold text-sanba-gold-text"
        >
          <Plus size={14} aria-hidden /> 素材を追加（カメラ・アップロード・画面共有）
        </button>
      )}

      {items.length === 0 ? (
        <p className="px-1 py-4 text-center text-[12.5px] text-sanba-muted">
          まだありません。資料を追加すると、ここに解析状況が出ます。
        </p>
      ) : (
        items.map((it) => {
          // 詳細（抽出要件/矛盾）が確定する done 行だけ詳細導線を出す。done 行は phrasing 要素
          // （テキスト）だけなので button に内包しても妥当な DOM になる（進捗バー div を含まない）。
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
                  {/* ✕ 中断（Figma 136:14・135:80）。押下で破棄確認ダイアログを開く。 */}
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

          // 詳細導線つきの行は行全体を1つのボタンにする（入れ子の対話要素を避ける）。
          if (openable) {
            return (
              <button
                key={it.id}
                type="button"
                aria-label={`資料 ${it.name} の詳細を開く`}
                onClick={() => onOpenDetail?.(it.id)}
                className={`${ROW_CLASS} text-left`}
              >
                {body}
              </button>
            );
          }

          return (
            <div key={it.id} aria-label={`資料 ${it.name}`} className={ROW_CLASS}>
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

      {/* 中断確認。続ける=閉じる、中断する=確定で当該素材を破棄する（onCancel）。
          対象が完了（done）等で in-flight でなくなったら liveTarget が外れ、確認は出さない。 */}
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
