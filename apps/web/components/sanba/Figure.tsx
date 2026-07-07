import * as React from "react";

import { cn } from "@/lib/utils";

export type FigureState = "walking" | "asking" | "listening" | "insight" | "writing";

export interface FigureProps extends React.SVGAttributes<SVGSVGElement> {
  state?: FigureState;
  label?: string;
  badge?: boolean;
}

function Joint({
  origin,
  animation,
  children,
}: {
  origin: string;
  animation: string;
  children: React.ReactNode;
}) {
  return (
    <g className="sanba-fig-joint" style={{ transformOrigin: origin, animation }}>
      {children}
    </g>
  );
}

const STROKE: React.SVGAttributes<SVGGElement> = {
  stroke: "var(--sanba-frame)",
  strokeWidth: 3,
  strokeLinecap: "round",
  fill: "none",
};

function Badge({ cx, cy, r = 4.5 }: { cx: number; cy: number; r?: number }) {
  return <circle cx={cx} cy={cy} r={r} fill="var(--sanba-gold)" strokeWidth={2} />;
}

export function Figure({
  className,
  state = "walking",
  label,
  badge = true,
  ...props
}: FigureProps) {
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);

  if (state === "walking") {
    return (
      <svg viewBox="0 0 60 90" className={cn("w-[34px]", className)} {...a11y} {...props}>
        <g {...STROKE}>
          <Joint origin="30px 45px" animation="sanba-fig-bob 0.72s ease-in-out infinite">
            <circle cx="30" cy="14" r="9" fill="var(--sanba-surface)" />
            <line x1="30" y1="23" x2="30" y2="56" />
            <Joint
              origin="30px 32px"
              animation="sanba-fig-swing 0.72s ease-in-out infinite alternate-reverse"
            >
              <line x1="30" y1="32" x2="18" y2="46" />
            </Joint>
            <Joint
              origin="30px 32px"
              animation="sanba-fig-swing 0.72s ease-in-out infinite alternate"
            >
              <line x1="30" y1="32" x2="42" y2="46" />
            </Joint>
            {badge && <Badge cx={30} cy={36} />}
          </Joint>
          <Joint
            origin="30px 56px"
            animation="sanba-fig-swing 0.72s ease-in-out infinite alternate"
          >
            <line x1="30" y1="56" x2="20" y2="84" />
          </Joint>
          <Joint
            origin="30px 56px"
            animation="sanba-fig-swing 0.72s ease-in-out infinite alternate-reverse"
          >
            <line x1="30" y1="56" x2="40" y2="84" />
          </Joint>
        </g>
      </svg>
    );
  }

  if (state === "asking") {
    return (
      <svg viewBox="0 0 84 108" className={cn("w-[62px]", className)} {...a11y} {...props}>
        <g {...STROKE}>
          <Joint origin="42px 30px" animation="sanba-fig-tilt 3.2s ease-in-out infinite">
            <circle cx="42" cy="26" r="12" fill="var(--sanba-surface)" />
          </Joint>
          <line x1="42" y1="38" x2="42" y2="70" />
          <line x1="42" y1="48" x2="26" y2="62" />
          <line x1="42" y1="48" x2="60" y2="56" />
          <line x1="42" y1="70" x2="30" y2="96" />
          <line x1="42" y1="70" x2="54" y2="96" />
          {badge && <Badge cx={42} cy={54} r={5} />}
        </g>
        <Joint origin="66px 18px" animation="sanba-fig-float 1.6s ease-in-out infinite">
          <text
            x="66"
            y="24"
            textAnchor="middle"
            fontSize="20"
            fontWeight="800"
            fill="var(--sanba-rec)"
          >
            ?
          </text>
        </Joint>
      </svg>
    );
  }

  if (state === "listening") {
    return (
      <svg viewBox="0 0 84 108" className={cn("w-[62px]", className)} {...a11y} {...props}>
        <g {...STROKE}>
          <circle cx="42" cy="26" r="12" fill="var(--sanba-surface)" />
          <line x1="42" y1="38" x2="42" y2="70" />
          <line x1="42" y1="48" x2="26" y2="62" />
          <path d="M42 48 L58 40 L56 30" />
          <line x1="42" y1="70" x2="30" y2="96" />
          <line x1="42" y1="70" x2="54" y2="96" />
          {badge && <Badge cx={42} cy={54} r={5} />}
          <g stroke="var(--sanba-speak)" strokeWidth={2}>
            <path
              className="sanba-fig-joint"
              style={{ animation: "sanba-fig-pulse 1.2s ease-in-out infinite" }}
              d="M66 22 q 5 6 0 12"
            />
            <path
              className="sanba-fig-joint"
              style={{ animation: "sanba-fig-pulse 1.2s ease-in-out 0.2s infinite" }}
              d="M72 18 q 8 10 0 20"
            />
            <path
              className="sanba-fig-joint"
              style={{ animation: "sanba-fig-pulse 1.2s ease-in-out 0.4s infinite" }}
              d="M78 14 q 11 14 0 28"
            />
          </g>
        </g>
      </svg>
    );
  }

  if (state === "insight") {
    return (
      <svg viewBox="0 0 84 108" className={cn("w-[62px]", className)} {...a11y} {...props}>
        <g {...STROKE}>
          <circle cx="42" cy="30" r="12" fill="var(--sanba-surface)" />
          <line x1="42" y1="42" x2="42" y2="72" />
          <Joint origin="42px 52px" animation="sanba-fig-cheer 1.4s ease-in-out infinite">
            <line x1="42" y1="52" x2="24" y2="36" />
          </Joint>
          <Joint origin="42px 52px" animation="sanba-fig-cheer-r 1.4s ease-in-out infinite">
            <line x1="42" y1="52" x2="60" y2="36" />
          </Joint>
          <line x1="42" y1="72" x2="30" y2="98" />
          <line x1="42" y1="72" x2="54" y2="98" />
          <circle
            className="sanba-fig-joint"
            style={{ animation: "sanba-fig-pulse 1.4s ease-in-out infinite" }}
            cx="42"
            cy="8"
            r="6"
            fill="var(--sanba-gold)"
            strokeWidth={2}
          />
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 84 108" className={cn("w-[62px]", className)} {...a11y} {...props}>
      <g {...STROKE}>
        <circle cx="34" cy="30" r="12" fill="var(--sanba-surface)" />
        <line x1="34" y1="42" x2="34" y2="68" />
        <line x1="34" y1="52" x2="20" y2="64" />
        <Joint origin="34px 52px" animation="sanba-fig-scribble 0.9s ease-in-out infinite">
          <line x1="34" y1="52" x2="54" y2="66" />
        </Joint>
        <line x1="34" y1="68" x2="24" y2="94" />
        <line x1="34" y1="68" x2="44" y2="94" />
        <rect x="46" y="68" width="26" height="32" rx="3" fill="var(--sanba-surface)" strokeWidth={2} />
        <line x1="51" y1="76" x2="67" y2="76" stroke="var(--sanba-border-strong)" strokeWidth={2} />
        <line x1="51" y1="83" x2="67" y2="83" stroke="var(--sanba-border-strong)" strokeWidth={2} />
        <line x1="51" y1="90" x2="61" y2="90" stroke="var(--sanba-select)" strokeWidth={2} />
      </g>
    </svg>
  );
}
