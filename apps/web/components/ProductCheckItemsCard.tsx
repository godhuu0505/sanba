"use client";

// 要件サンバ中の確認項目カード（アプリ管理画面 /products/[id]）。
// 「セッション中に必ず確認する項目」を対象（全員/利用者/企画者/開発者）付きで登録する
// （ADR-0040）。上限はサーバの check_items_limit（既定 10）。登録内容はセッション開始時に
// 対象に合う項目だけが agent の初期 instructions へシードされ、結果ドキュメントにも載る。
// 操作ごとの即時保存（追加/削除のたびに PATCH。失敗は表示だけ知らせる）は語彙カードと同じ。

import { useState } from "react";

import { Button, Card, CardTitle, Chip, Input, Select } from "@/components/sanba";
import { updateProduct, type Audience, type CheckItem, type Product } from "@/lib/api";
import { AUDIENCE_LABELS, AUDIENCES } from "@/lib/audience";
import { useAuth } from "@/lib/auth";

/** 対象セレクタの値。"all" = 全員（API へは target: null で送る）。 */
type TargetChoice = Audience | "all";

const TARGET_LABELS: Record<TargetChoice, string> = {
  all: "全員",
  end_user: AUDIENCE_LABELS.end_user,
  planner: AUDIENCE_LABELS.planner,
  developer: AUDIENCE_LABELS.developer,
};

function sameItem(a: CheckItem, b: CheckItem): boolean {
  return a.text === b.text && a.target === b.target;
}

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
  const [newTarget, setNewTarget] = useState<TargetChoice>("all");
  const [error, setError] = useState<string | null>(null);

  const items = product.check_items;
  const limit = product.check_items_limit;
  const full = items.length >= limit;

  async function save(next: CheckItem[]) {
    setError(null);
    try {
      onSaved(await updateProduct(product.id, { check_items: next }, idToken));
    } catch {
      // 楽観更新はしない（onSaved でのみ反映）ので巻き戻し不要。失敗だけ知らせる。
      setError("確認項目の保存に失敗しました");
    }
  }

  function handleAdd() {
    const text = newItem.trim();
    if (!text) return;
    if (text.length > 200) {
      setError("確認項目は 200 文字以内で入力してください");
      return;
    }
    if (full) {
      setError(`確認項目は最大 ${limit} 個までです`);
      return;
    }
    const item: CheckItem = { text, target: newTarget === "all" ? null : newTarget };
    if (items.some((i) => sameItem(i, item))) {
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
        セッション中に必ず確認したい項目です（最大 {limit} 個）。対象を選ぶと、その相手との
        セッションでだけ確認します（全員 = どのセッションでも確認）。産婆さんが会話の流れの
        中で一つずつ確認し、要件結果の文書にも一覧が載ります。
      </p>
      <p className="text-[11px] font-bold text-sanba-muted" aria-label="確認項目の登録数">
        {items.length} / {limit} 個
      </p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-[6px]">
          {items.map((item) => (
            <li
              key={`${item.target ?? "all"}:${item.text}`}
              className="flex items-start gap-[8px] rounded-[10px] border border-sanba-border bg-sanba-bg px-[10px] py-[8px]"
            >
              <Chip tone={item.target ? "gold" : "neutral"} size="sm">
                {TARGET_LABELS[item.target ?? "all"]}
              </Chip>
              <span className="flex-1 text-[13px] leading-relaxed text-sanba-cream">
                {item.text}
              </span>
              <button
                type="button"
                aria-label={`${item.text} を削除`}
                className="text-sanba-muted hover:text-sanba-cream"
                onClick={() => void save(items.filter((i) => !sameItem(i, item)))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-[8px]">
        <Select
          aria-label="確認項目の対象"
          value={newTarget}
          disabled={full}
          onChange={(e) => setNewTarget(e.target.value as TargetChoice)}
          className="w-[110px] shrink-0"
        >
          {(["all", ...AUDIENCES] as TargetChoice[]).map((t) => (
            <option key={t} value={t}>
              {TARGET_LABELS[t]}
            </option>
          ))}
        </Select>
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
          placeholder={full ? `上限（${limit} 個）に達しています` : "例: ログイン方式を確認する"}
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
