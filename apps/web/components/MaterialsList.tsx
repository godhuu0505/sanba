"use client";

// 参考資料タブの本文。投入済み素材を一覧し、解析進捗をインライン表示する。
// 仕様: docs/design/conversation-experience.md §3,§6 / screens/05-materials.md。
// 解析はバックグラウンドで進む（会話を止めない）ため、各行に状態（アップロード/解析中/完了/失敗）を出す。

// 素材ビューモデルは共有セレクタ層（selectMaterials）に寄せ、ここでは再エクスポートのみ。
import type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

export type { MaterialItem, MaterialStatus } from "@/lib/realtime/selectors";

export interface MaterialsListProps {
  items: MaterialItem[];
  /** 「＋ 素材を追加」押下（手段選択へ）。 */
  onAdd: () => void;
  /** 失敗行の再試行。 */
  onRetry?: (id: string) => void;
  /**
   * 素材行 → 05-1 詳細（抽出要件・言葉×画の矛盾）を開く（#202）。
   * 抽出要件/矛盾は解析完了（analysis.visual）で初めて確定するため、詳細導線は done 行のみ。
   * 解析中/アップロード中/失敗の行は出さない（中身が無い & 進捗バーを button に内包させない）。
   */
  onOpenDetail?: (id: string) => void;
}

const STATUS_LABEL: Record<Exclude<MaterialStatus, "done" | "failed">, string> = {
  uploading: "アップロード中",
  analyzing: "解析中",
};

const ROW_CLASS =
  "flex flex-col gap-[6px] rounded-[12px] border border-[var(--sanba-border)] bg-[#1b140b] px-3 py-[11px]";

export function MaterialsList({ items, onAdd, onRetry, onOpenDetail }: MaterialsListProps) {
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
          // 詳細（抽出要件/矛盾）が確定する done 行だけ詳細導線を出す。done 行は phrasing 要素
          // （テキスト）だけなので button に内包しても妥当な DOM になる（進捗バー div を含まない）。
          const openable = !!onOpenDetail && it.status === "done";

          const body = (
            <>
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
    </div>
  );
}
