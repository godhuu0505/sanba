import * as React from "react";

import { cn } from "@/lib/utils";

// 1.5px 墨枠＋角丸12（コントロール規定 / ADR-0033）。フォーカスで山吹の輪が灯る。
const baseControl =
  "w-full rounded-[12px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[14px] py-[12px] text-[14px] text-sanba-cream placeholder:text-sanba-muted/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sanba-gold disabled:cursor-not-allowed disabled:opacity-50";

/** SANBA 配色の 1 行入力。Figma の goal-input / Input に対応。 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(baseControl, className)} {...props} />
  ),
);
Input.displayName = "SanbaInput";

/** SANBA 配色の複数行入力。テーマ入力など。 */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(baseControl, "resize-none", className)} {...props} />
));
Textarea.displayName = "SanbaTextarea";

/** SANBA 配色の選択。要件編集の優先度/分類など。native select で軽量。 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  // native の矢印は OS 描画に委ね（appearance はいじらない）、配色のみ baseControl で揃える。
  <select ref={ref} className={cn(baseControl, "cursor-pointer", className)} {...props} />
));
Select.displayName = "SanbaSelect";

/** ラベル＋任意の補助テキストで入力をくるむ最小フォーム行。 */
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  /**
   * ラベル脇の目印（必須/任意バッジ等）。<label> 要素の *外* に置くので、
   * getByLabelText で参照するアクセシブルなラベル文字列を汚さない。
   */
  marker?: React.ReactNode;
}

export function Field({ className, label, htmlFor, hint, marker, children, ...props }: FieldProps) {
  const autoId = React.useId();
  // htmlFor が未指定のとき、先頭の子が既に id を持つならそれを採用する。
  // こうしないと label の htmlFor が autoId を指す一方で子は独自 id を持ち、関連付けが壊れる。
  const firstChild = React.Children.toArray(children)[0];
  const childId =
    React.isValidElement<{ id?: string }>(firstChild) ? firstChild.props.id : undefined;
  const fieldId = htmlFor ?? childId ?? autoId;
  const clonedChildren = React.Children.map(children, (child, i) => {
    // React 19 では isValidElement に props 型を渡さないと child.props が unknown になる。
    if (i === 0 && React.isValidElement<{ id?: string }>(child) && !child.props.id) {
      return React.cloneElement(child, { id: fieldId });
    }
    return child;
  });
  return (
    <div className={cn("flex w-full flex-col gap-[6px]", className)} {...props}>
      <div className="flex items-center">
        <label htmlFor={fieldId} className="text-[13px] font-bold text-sanba-muted">
          {label}
        </label>
        {marker}
      </div>
      {clonedChildren}
      {hint && <p className="text-[12px] text-sanba-muted/80">{hint}</p>}
    </div>
  );
}
