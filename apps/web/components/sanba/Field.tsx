import * as React from "react";

import { cn } from "@/lib/utils";

const baseControl =
  "w-full rounded-[12px] border border-[var(--sanba-border)] bg-[var(--sanba-surface)] px-[14px] py-[12px] text-[14px] text-[var(--sanba-cream)] placeholder:text-[var(--sanba-muted)]/70 transition-colors focus-visible:outline-none focus-visible:border-[var(--sanba-frame)] focus-visible:ring-1 focus-visible:ring-[var(--sanba-gold)] disabled:cursor-not-allowed disabled:opacity-50";

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

/** ラベル＋任意の補助テキストで入力をくるむ最小フォーム行。 */
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
}

export function Field({ className, label, htmlFor, hint, children, ...props }: FieldProps) {
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
      <label htmlFor={fieldId} className="text-[13px] font-bold text-[var(--sanba-muted)]">
        {label}
      </label>
      {clonedChildren}
      {hint && <p className="text-[12px] text-[var(--sanba-muted)]/80">{hint}</p>}
    </div>
  );
}
