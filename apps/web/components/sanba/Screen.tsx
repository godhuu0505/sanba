import * as React from "react";

import { cn } from "@/lib/utils";

export interface ScreenProps extends React.HTMLAttributes<HTMLDivElement> {
  bordered?: boolean;
}

export function Screen({ className, bordered = false, ...props }: ScreenProps) {
  return (
    <div
      data-sanba-screen=""
      className={cn(
        "sanba-screen-bg sanba-font flex min-h-dvh w-full flex-col text-sanba-cream",
        bordered && "border-[2.5px] border-sanba-frame",
        className,
      )}
      {...props}
    />
  );
}

export interface PhoneFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  fluidHeight?: boolean;
}

export function PhoneFrame({ className, fluidHeight = false, children, ...props }: PhoneFrameProps) {
  return (
    <div
      className={cn(
        "w-[390px] shrink-0 overflow-hidden rounded-[30px] border-[2.5px] border-sanba-frame shadow-[8px_8px_0_var(--sanba-shadow)]",
        !fluidHeight && "h-[844px]",
        className,
      )}
      {...props}
    >
      <Screen className="h-full sanba-scroll overflow-y-auto">{children}</Screen>
    </div>
  );
}
