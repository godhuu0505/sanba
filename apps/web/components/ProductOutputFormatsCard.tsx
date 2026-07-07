"use client";

import { useState } from "react";

import { Button, Card, CardTitle, Chip, Textarea } from "@/components/sanba";
import { updateProduct, type Audience, type Product } from "@/lib/api";
import { AUDIENCE_LABELS, AUDIENCES } from "@/lib/audience";
import { useAuth } from "@/lib/auth";

export function ProductOutputFormatsCard({
  product,
  onSaved,
}: {
  product: Product;
  onSaved: (updated: Product) => void;
}) {
  const auth = useAuth();
  const idToken = auth.credential;

  const [audience, setAudience] = useState<Audience>("end_user");
  const [drafts, setDrafts] = useState<Record<Audience, string>>(() => ({
    end_user: product.output_formats.end_user ?? "",
    planner: product.output_formats.planner ?? "",
    developer: product.output_formats.developer ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Audience | null>(null);

  const registered = Boolean((product.output_formats[audience] ?? "").trim());
  const draft = drafts[audience];

  async function save(value: string) {
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      const updated = await updateProduct(
        product.id,
        { output_formats: { ...drafts, [audience]: value } },
        idToken,
      );
      setDrafts((prev) => ({ ...prev, [audience]: value.trim() }));
      onSaved(updated);
      setSavedAt(audience);
    } catch {
      setError("出力フォーマットの保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>要件結果の出力フォーマット</CardTitle>
      <p className="text-[12px] leading-relaxed text-sanba-muted">
        セッション結果の文書を、読み手（利用者・企画者・開発者）ごとの体裁で出力します。
        それぞれ 1 つ登録でき、登録しない場合はデフォルトのフォーマットが使われます。
      </p>
      <div className="flex flex-wrap gap-[8px]" role="tablist" aria-label="出力フォーマットの対象">
        {AUDIENCES.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={audience === a}
            onClick={() => {
              setAudience(a);
              setError(null);
              setSavedAt(null);
            }}
          >
            <Chip tone={audience === a ? "gold" : "neutral"} size="md">
              {AUDIENCE_LABELS[a]}向け
            </Chip>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-[8px]">
        <Chip tone={registered ? "success" : "neutral"} size="sm">
          {registered ? "登録済み" : "デフォルト使用中"}
        </Chip>
        {savedAt === audience && (
          <span className="text-[11px] text-sanba-gold-text">保存しました</span>
        )}
      </div>
      <Textarea
        aria-label={`${AUDIENCE_LABELS[audience]}向け出力フォーマット`}
        value={draft}
        rows={10}
        maxLength={8000}
        onChange={(e) => setDrafts((prev) => ({ ...prev, [audience]: e.target.value }))}
        placeholder={`未登録です。空のまま保存するとデフォルトのフォーマットが使われます。\n{{session_title}} {{app_name}} {{goal}} {{date}} {{requirements}} {{requirements_plain}} {{check_items}} が使えます。`}
      />
      <details>
        <summary className="cursor-pointer text-[12px] font-bold text-sanba-gold-text">
          デフォルトのフォーマットを見る
        </summary>
        <pre className="mt-[8px] max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-sanba-border bg-sanba-bg p-[10px] text-[11px] leading-relaxed text-sanba-muted">
          {product.output_format_defaults[audience]}
        </pre>
      </details>
      <div className="flex gap-[8px]">
        <Button variant="outline" block disabled={busy} onClick={() => void save(draft)}>
          {AUDIENCE_LABELS[audience]}向けを保存する
        </Button>
        {registered && (
          <Button
            variant="outline"
            size="md"
            disabled={busy}
            onClick={() => {
              setDrafts((prev) => ({ ...prev, [audience]: "" }));
              void save("");
            }}
          >
            デフォルトに戻す
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-sanba-rec-text">
          {error}
        </p>
      )}
    </Card>
  );
}
