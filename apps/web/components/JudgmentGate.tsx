"use client";

import { Scale, TriangleAlert } from "lucide-react";

import type { InquiryNode } from "@/lib/realtime/types";

import { Button, HelpIcon } from "@/components/sanba";
import { InquiryTree } from "./InquiryTree";

export interface JudgmentGateProps {
  unresolved: number;
  nodes?: InquiryNode[];
  onBack: () => void;
  onForceEnd: () => void;
  onConfirm: () => void;
  error?: string;
  onDrop?: (nodeId: string) => void;
}

export function JudgmentGate({
  unresolved,
  nodes,
  onBack,
  onForceEnd,
  onConfirm,
  error,
  onDrop,
}: JudgmentGateProps) {
  const resolved = unresolved === 0;

  return (
    <div className="flex h-full flex-col items-center px-4 pb-6 pt-12">
      <div
        className="flex size-20 items-center justify-center rounded-full text-[32px] font-bold"
        style={
          resolved
            ? { background: "var(--sanba-gold)", color: "var(--sanba-ink)" }
            : {
                backgroundColor: "var(--sanba-rec-pale)",
                border: "2px solid var(--sanba-rec)",
                color: "var(--sanba-rec)",
              }
        }
      >
        {resolved ? <Scale size={32} aria-hidden /> : <TriangleAlert size={32} aria-hidden />}
      </div>
      <div className="mt-3 flex items-center gap-1">
        <p className="text-[18px] font-bold text-sanba-gold-text">内容の確認</p>
        <HelpIcon term="内容の確認" />
      </div>

      {resolved ? (
        <>
          <p className="mt-1 text-center text-[12.5px] text-sanba-muted">
            すべて確認できました。要件を確定できます。
          </p>
          <div className="flex-1" />
          {error && (
            <p role="alert" className="mb-2 w-full text-center text-[12px] text-sanba-rec-text">
              {error}
            </p>
          )}
          <Button variant="gold" size="lg" block onClick={onConfirm}>
            要件を確定する
          </Button>
        </>
      ) : (
        <>
          <div className="mt-4 w-full rounded-[14px] border-[1.5px] border-sanba-rec bg-sanba-rec-pale p-[14px]">
            <p className="text-[16px] font-bold text-sanba-rec-text">
              {`未解消が ${unresolved} 件あります`}
            </p>
            <p className="mt-1 text-[11.5px] text-sanba-muted">
              未解消が残っていると、要件を確定できません。
            </p>
          </div>
          {nodes && nodes.length > 0 && (
            <div className="mt-3 w-full">
              <InquiryTree nodes={nodes} onDrop={onDrop} />
            </div>
          )}
          <div className="flex-1" />
          <Button variant="gold" size="lg" block onClick={onBack}>
            会話に戻って確認する
          </Button>
          <button
            type="button"
            onClick={onForceEnd}
            className="mt-2 w-full rounded-[12px] border border-sanba-rec/40 py-3 text-[12.5px] font-bold text-sanba-rec-text"
          >
            未解消のまま終える
          </button>
        </>
      )}
    </div>
  );
}
