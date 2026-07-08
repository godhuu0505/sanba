"use client";

import { useState } from "react";

import { Button, Card, CardTitle, Chip, HelpIcon, Input, Select } from "@/components/sanba";
import { updateProduct, type Audience, type CheckItem, type Product } from "@/lib/api";
import { AUDIENCE_LABELS, AUDIENCES } from "@/lib/audience";
import { useAuth } from "@/lib/auth";

type TargetChoice = Audience | "all";

const TARGET_LABELS: Record<TargetChoice, string> = {
  all: "全員",
  end_user: AUDIENCE_LABELS.end_user,
  planner: AUDIENCE_LABELS.planner,
  developer: AUDIENCE_LABELS.developer,
};

type CheckPointScope = "developer" | "end_user";

const SCOPE_ORDER: CheckPointScope[] = ["developer", "end_user"];

const SCOPE_LABELS: Record<CheckPointScope, string> = {
  developer: AUDIENCE_LABELS.developer,
  end_user: AUDIENCE_LABELS.end_user,
};

const SCOPE_ALLOWED_TARGETS: Record<CheckPointScope, (Audience | null)[]> = {
  end_user: [null, "end_user"],
  developer: [null, "planner", "developer"],
};

const SCOPE_DUPLICATE_TARGET: Record<CheckPointScope, Audience> = {
  end_user: "end_user",
  developer: "developer",
};

function sameItem(a: CheckItem, b: CheckItem): boolean {
  return a.text === b.text && a.target === b.target;
}

function scopeConfigured(items: CheckItem[], scope: CheckPointScope): boolean {
  const allowed = SCOPE_ALLOWED_TARGETS[scope];
  return items.some((i) => allowed.includes(i.target));
}

export function ProductCheckItemsCard({
  product,
  onSaved,
}: {
  product: Product;
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

  const defaults = product.check_point_defaults ?? {};
  const unsetScopes = SCOPE_ORDER.filter(
    (scope) => (defaults[scope]?.length ?? 0) > 0 && !scopeConfigured(items, scope),
  );

  function handleDuplicate(scope: CheckPointScope) {
    const target = SCOPE_DUPLICATE_TARGET[scope];
    const additions = (defaults[scope] ?? [])
      .map((text) => ({ text, target }))
      .filter((cand) => !items.some((i) => sameItem(i, cand)));
    if (additions.length === 0) return;
    const room = limit - items.length;
    if (room <= 0) {
      setError(`確認項目は最大 ${limit} 個までです`);
      return;
    }
    setError(null);
    void save([...items, ...additions.slice(0, room)]);
  }

  return (
    <Card>
      <CardTitle className="inline-flex items-center gap-[6px]">
        会話中の確認項目
        <HelpIcon term="確認項目" />
      </CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        会話中に必ず確認したい項目です（最大 {limit} 個）。対象を選ぶと、その相手との
        会話でだけ確認します（全員 = どの会話でも確認）。会話の流れの
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
      {unsetScopes.length > 0 && (
        <div className="flex flex-col gap-[10px] rounded-[10px] border border-dashed border-sanba-border bg-sanba-bg px-[10px] py-[10px]">
          <p className="text-[12px] leading-relaxed text-sanba-muted">
            未設定のモードでは、以下のデフォルト観点で会話を進めます。必要なら複製して編集できます。
          </p>
          {unsetScopes.map((scope) => (
            <section key={scope} aria-label={`${SCOPE_LABELS[scope]}のデフォルト観点`}>
              <div className="flex items-center justify-between gap-[8px]">
                <p className="inline-flex items-center gap-[6px] text-[12px] font-bold text-sanba-cream">
                  <Chip tone="neutral" size="sm">
                    {SCOPE_LABELS[scope]}
                  </Chip>
                  デフォルト観点
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={full}
                  aria-label={`${SCOPE_LABELS[scope]}のデフォルト観点を複製`}
                  onClick={() => handleDuplicate(scope)}
                >
                  デフォルトを複製
                </Button>
              </div>
              <ul className="mt-[6px] flex flex-col gap-[3px]">
                {(defaults[scope] ?? []).map((text) => (
                  <li key={text} className="text-[12px] leading-relaxed text-sanba-muted">
                    ・{text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
