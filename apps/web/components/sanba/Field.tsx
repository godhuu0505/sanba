import * as React from "react";

import { cn } from "@/lib/utils";

const baseControl =
  "w-full rounded-[12px] border-[1.5px] border-sanba-frame bg-sanba-surface px-[14px] py-[12px] text-[14px] text-sanba-cream placeholder:text-sanba-muted/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sanba-gold disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(baseControl, className)} {...props} />
  ),
);
Input.displayName = "SanbaInput";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(baseControl, "resize-none", className)} {...props} />
));
Textarea.displayName = "SanbaTextarea";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(baseControl, "cursor-pointer", className)} {...props} />
));
Select.displayName = "SanbaSelect";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  marker?: React.ReactNode;
}

export function Field({ className, label, htmlFor, hint, marker, children, ...props }: FieldProps) {
  const autoId = React.useId();
  const firstChild = React.Children.toArray(children)[0];
  const childId =
    React.isValidElement<{ id?: string }>(firstChild) ? firstChild.props.id : undefined;
  const fieldId = htmlFor ?? childId ?? autoId;
  const clonedChildren = React.Children.map(children, (child, i) => {
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
