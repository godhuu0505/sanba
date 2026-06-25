"use client";

// 参考資料タブの本文。投入済み素材を一覧し、解析進捗をインライン表示する。
// 仕様: docs/design/conversation-experience.md §3,§6 / screens/05-materials.md。
// 解析はバックグラウンドで進む（会話を止めない）ため、各行に状態（アップロード/解析中/完了/失敗）を出す。

export type MaterialStatus = "uploading" | "analyzing" | "done" | "failed";

export interface MaterialItem {
  id: string;
  /** 表示名（無ければ asset_id）。 */
  name: string;
  /** 進捗 0–100。 */
  pct: number;
  status: MaterialStatus;
  /** 完了時の抽出要件数（任意）。 */
  extracted?: number;
}

export interface MaterialsListProps {
  items: MaterialItem[];
  /** 「＋ 素材を追加」押下（手段選択へ）。 */
  onAdd: () => void;
  /** 失敗行の再試行。 */
  onRetry?: (id: string) => void;
}

const STATUS_LABEL: Record<Exclude<MaterialStatus, "done" | "failed">, string> = {
  uploading: "アップロード中",
  analyzing: "解析中",
};

export function MaterialsList({ items, onAdd, onRetry }: MaterialsListProps) {
  return (
    <div className="flex flex-col gap-[10px] px-4 py-3">
      <button
        type="button"
        onClick={onAdd}
        className="rounded-[12px] border border-dashed border-[var(--sanba-frame)] bg-[#1b140b] px-3 py-[13px] text-[12.5px] font-bold text-[var(--sanba-gold-text)]"
      >
        ＋ 素材を追加（カメラ・アップロード・Drive）
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
                </div>
              )}

              {it.status === "failed" && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-[var(--sanba-rec)]">アップロード/解析に失敗</span>
                  <button
                    type="button"
                    onClick={() => onRetry?.(it.id)}
                    className="rounded-full border border-[var(--sanba-frame)] px-[9px] py-[3px] text-[11px] font-bold text-[var(--sanba-gold-text)]"
                  >
                    再試行
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
