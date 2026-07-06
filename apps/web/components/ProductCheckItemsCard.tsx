"use client";

// 要件サンバ中の確認項目カード（アプリ管理画面 /products/[id]）。
// 「セッション中に必ず確認する項目」を最大 10 個登録する。登録内容はセッション開始時に
// agent の初期 instructions へシードされ、要件結果ドキュメントにも一覧が載る。
// 操作ごとの即時保存（追加/削除のたびに PATCH。失敗時は表示を巻き戻す）は語彙カードと同じ。

import { useState } from "react";

import { Button, Card, CardTitle, Input } from "@/components/sanba";
import { updateProduct, type Product } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** 登録上限（API 側の MAX_CHECK_ITEMS と同値。正はサーバ側のバリデーション）。 */
export const MAX_CHECK_ITEMS = 10;

export function ProductCheckItemsCard({
  product,
  onSaved,
}: {
  product: Product;
  /** 保存成功後に親の product 表示を最新化するためのフック。 */
  onSaved: (updated: Product) => void;
}) {
  const auth = useAuth();
  const idToken = auth.credential;

  const [newItem, setNewItem] = useState("");
  const [error, setError] = useState<string | null>(null);

  const items = product.check_items;
  const full = items.length >= MAX_CHECK_ITEMS;

  async function save(next: string[]) {
    setError(null);
    try {
      onSaved(await updateProduct(product.id, { check_items: next }, idToken));
    } catch {
      // 楽観更新はしない（onSaved でのみ反映）ので巻き戻し不要。失敗だけ知らせる。
      setError("確認項目の保存に失敗しました");
    }
  }

  function handleAdd() {
    const item = newItem.trim();
    if (!item) return;
    if (item.length > 200) {
      setError("確認項目は 200 文字以内で入力してください");
      return;
    }
    if (full) {
      setError(`確認項目は最大 ${MAX_CHECK_ITEMS} 個までです`);
      return;
    }
    if (items.includes(item)) {
      setNewItem("");
      return;
    }
    setNewItem("");
    void save([...items, item]);
  }

  return (
    <Card>
      <CardTitle>要件サンバ中の確認項目</CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        セッション中に必ず確認したい項目です（最大 {MAX_CHECK_ITEMS} 個）。産婆さんが会話の
        流れの中で一つずつ確認し、要件結果の文書にも一覧が載ります。
      </p>
      <p className="text-[11px] font-bold text-sanba-muted" aria-label="確認項目の登録数">
        {items.length} / {MAX_CHECK_ITEMS} 個
      </p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-[6px]">
          {items.map((item) => (
            <li
              key={item}
              className="flex items-start gap-[8px] rounded-[10px] border border-sanba-border bg-sanba-bg px-[10px] py-[8px]"
            >
              <span className="flex-1 text-[13px] leading-relaxed text-sanba-cream">{item}</span>
              <button
                type="button"
                aria-label={`${item} を削除`}
                className="text-sanba-muted hover:text-sanba-cream"
                onClick={() => void save(items.filter((i) => i !== item))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-[8px]">
        <Input
          aria-label="確認項目を追加"
          value={newItem}
          maxLength={200}
          disabled={full}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={full ? `上限（${MAX_CHECK_ITEMS} 個）に達しています` : "例: ログイン方式を確認する"}
        />
        {/* 語彙カードの「追加」とアクセシブルネームが衝突しないよう明示ラベルを付ける。 */}
        <Button
          variant="outline"
          size="md"
          disabled={full}
          aria-label="確認項目を追加する"
          onClick={handleAdd}
        >
          追加
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-sanba-rec-text">
          {error}
        </p>
      )}
    </Card>
  );
}
