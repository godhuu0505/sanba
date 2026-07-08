"use client";

import { Check, Circle, ListChecks } from "lucide-react";

import type { CoveragePoint } from "@/lib/realtime/types";

export interface CoverageProgressProps {
  coverage: CoveragePoint[];
}

export function CoverageProgress({ coverage }: CoverageProgressProps) {
  if (coverage.length === 0) return null;
  const covered = coverage.filter((p) => p.covered).length;
  return (
    <section
      className="rounded-[12px] border border-sanba-border bg-sanba-surface-strong px-[12px] py-[9px]"
      aria-label="確認する観点の進捗"
    >
      <p className="flex items-center gap-1.5 text-[12px] font-bold text-sanba-gold-text">
        <ListChecks size={13} aria-hidden />
        確認する観点
        <span className="ml-auto text-[10.5px] font-normal text-sanba-muted">
          {covered}/{coverage.length}
        </span>
      </p>
      <ul className="mt-[7px] flex flex-col gap-[5px]">
        {coverage.map((p) => (
          <li
            key={p.label}
            className="flex items-start gap-1.5 text-[11.5px]"
          >
            <span aria-hidden className="mt-[1px] shrink-0">
              {p.covered ? (
                <Check size={13} className="text-sanba-speak-text" />
              ) : (
                <Circle size={13} className="text-sanba-muted" />
              )}
            </span>
            <span
              className={p.covered ? "text-sanba-muted line-through" : "text-sanba-text"}
            >
              {p.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
