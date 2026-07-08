"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import { HelpIcon } from "@/components/sanba";
import { inquiryHelpTerm, inquiryPresentation } from "@/lib/realtime/mapping";
import type { InquiryNode } from "@/lib/realtime/types";

export interface InquiryTreeProps {
  nodes: InquiryNode[];
  onDrop?: (nodeId: string) => void;
}

interface TreeNode {
  node: InquiryNode;
  children: TreeNode[];
}

function buildForest(nodes: InquiryNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const node of nodes) byId.set(node.id, { node, children: [] });
  const roots: TreeNode[] = [];
  for (const node of nodes) {
    const entry = byId.get(node.id);
    if (!entry) continue;
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  const bySeq = (a: TreeNode, b: TreeNode) => a.node.created_seq - b.node.created_seq;
  roots.sort(bySeq);
  for (const entry of byId.values()) entry.children.sort(bySeq);
  return roots;
}

interface InquiryRowProps {
  entry: TreeNode;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onDrop?: (nodeId: string) => void;
}

function InquiryRow({ entry, expanded, onToggle, onDrop }: InquiryRowProps) {
  const { node, children } = entry;
  const k = inquiryPresentation(node.kind);
  const resolved = node.status === "resolved";
  const open = node.status === "open";
  const showRefs = expanded.has(node.id);

  return (
    <li>
      <div
        className="rounded-[12px] border bg-sanba-surface px-3 py-[9px]"
        style={{
          borderColor: resolved ? "var(--sanba-border)" : k.color,
          opacity: resolved ? 0.72 : 1,
        }}
      >
        <div className="flex items-start gap-2">
          <span
            aria-label={k.ariaLabel}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-bold text-white"
            style={{ backgroundColor: k.color }}
          >
            <k.Icon size={11} aria-hidden /> {k.label}
          </span>
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={showRefs}
            className="flex-1 text-left text-[12.5px] font-bold text-sanba-cream"
          >
            {resolved && <span aria-hidden>✓ </span>}
            {node.text}
          </button>
          <HelpIcon term={inquiryHelpTerm(node.kind)} />
        </div>
        {resolved && <p className="mt-[2px] pl-1 text-[10px] text-sanba-speak-text">解消済</p>}
        {showRefs && (
          <p className="mt-1 pl-1 text-[10.5px] text-sanba-muted">
            {node.refs.length > 0
              ? `根拠: ${node.refs.join(" · ")}`
              : "根拠は記録されていません。"}
          </p>
        )}
        {open && onDrop && (
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              aria-label={`「${node.text}」を不要にする`}
              onClick={() => onDrop(node.id)}
              className="inline-flex items-center gap-[2px] text-[11px] font-bold text-sanba-muted"
            >
              <X size={11} aria-hidden /> 不要
            </button>
          </div>
        )}
      </div>
      {children.length > 0 && (
        <ul className="ml-2 mt-[6px] flex flex-col gap-[6px] border-l-2 border-sanba-border pl-3">
          {children.map((c) => (
            <InquiryRow
              key={c.node.id}
              entry={c}
              expanded={expanded}
              onToggle={onToggle}
              onDrop={onDrop}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function InquiryTree({ nodes, onDrop }: InquiryTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showDropped, setShowDropped] = useState(false);

  const visible = useMemo(() => nodes.filter((n) => n.status !== "dropped"), [nodes]);
  const dropped = useMemo(() => nodes.filter((n) => n.status === "dropped"), [nodes]);
  const forest = useMemo(() => buildForest(visible), [visible]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (visible.length === 0 && dropped.length === 0) {
    return (
      <p className="px-1 py-3 text-[12px] text-sanba-muted">
        確認事項はありません（すべて確認できました）。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-[6px]">
        {forest.map((t) => (
          <InquiryRow
            key={t.node.id}
            entry={t}
            expanded={expanded}
            onToggle={toggle}
            onDrop={onDrop}
          />
        ))}
      </ul>
      {dropped.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={showDropped}
            onClick={() => setShowDropped((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-sanba-muted"
          >
            {showDropped ? (
              <ChevronDown size={12} aria-hidden />
            ) : (
              <ChevronRight size={12} aria-hidden />
            )}
            {`除外 ${dropped.length}`}
          </button>
          {showDropped && (
            <ul className="mt-1 flex flex-col gap-1 pl-4">
              {dropped.map((n) => (
                <li key={n.id} className="text-[11px] text-sanba-muted line-through">
                  {n.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
