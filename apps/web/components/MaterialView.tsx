"use client";

// 06 素材を渡す — マルチモーダルの入口（Issue #98 / ADR-0004）。
//
// 言葉以外の情報（画像・動画・画面共有・カメラ）を渡す入口。本 issue では API 追加不要で
// 独立着手できる **画面共有・カメラ**（既存 LiveKit 映像トラック）を実装する。
// 画像/動画アップロードは API 拡張（#103）が前提のため「準備中」でグレーアウトし、誤操作を防ぐ。

import { useLocalParticipant } from "@livekit/components-react";
import { useState } from "react";

export function MaterialView() {
  const { localParticipant } = useLocalParticipant();
  const [sharing, setSharing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleScreenShare() {
    setError(null);
    try {
      const next = !sharing;
      await localParticipant.setScreenShareEnabled(next);
      setSharing(next);
    } catch (e) {
      setError(`画面共有を開始できませんでした: ${String(e)}`);
    }
  }

  async function toggleCamera() {
    setError(null);
    try {
      const next = !camera;
      await localParticipant.setCameraEnabled(next);
      setCamera(next);
    } catch (e) {
      setError(`カメラを開始できませんでした: ${String(e)}`);
    }
  }

  return (
    <section style={{ paddingBottom: 80 }}>
      <h2 style={{ fontSize: 18, margin: "8px 0 4px" }}>素材を渡す</h2>
      <p style={{ margin: "0 0 16px", color: "#666", fontSize: 13 }}>
        情報を渡す手段を選ぶ。テキスト・音声に加え、画像/動画/画面共有も渡せます。
      </p>

      {/* 画像/動画は API 拡張（#103）が前提。準備中でグレーアウトし誤操作を防ぐ。 */}
      <MaterialRow
        icon="🖼"
        title="画像をアップロード"
        sub="モック・スクショ・写真（PNG/JPG）"
        pending
      />
      <MaterialRow
        icon="🎥"
        title="動画をアップロード"
        sub="操作録画・画面収録（MP4/MOV）"
        pending
      />
      <MaterialRow
        icon="🖥"
        title={sharing ? "画面共有を停止" : "画面を共有"}
        sub="ライブ（Figma 等）"
        active={sharing}
        onClick={toggleScreenShare}
      />
      <MaterialRow
        icon="📷"
        title={camera ? "カメラを停止" : "カメラで撮影"}
        sub="ホワイトボード／手書き"
        active={camera}
        onClick={toggleCamera}
      />

      {error && <p style={{ color: "crimson", fontSize: 14 }}>{error}</p>}
    </section>
  );
}

function MaterialRow({
  icon,
  title,
  sub,
  onClick,
  pending,
  active,
}: {
  icon: string;
  title: string;
  sub: string;
  onClick?: () => void;
  pending?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      aria-disabled={pending}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: 14,
        margin: "8px 0",
        borderRadius: 12,
        border: active ? "1px solid #2F6FED" : "1px solid #eee",
        background: pending ? "#f6f6f6" : "#fff",
        color: pending ? "#aaa" : "#222",
        cursor: pending ? "not-allowed" : "pointer",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 22 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>
          {title}
          {pending && <span style={pendingBadge}>準備中</span>}
          {active && <span style={activeBadge}>ON</span>}
        </span>
        <span style={{ display: "block", fontSize: 12, color: pending ? "#bbb" : "#777" }}>
          {sub}
        </span>
      </span>
      <span aria-hidden="true" style={{ color: "#ccc" }}>
        ›
      </span>
    </button>
  );
}

const pendingBadge = {
  marginLeft: 8,
  fontSize: 11,
  color: "#999",
  background: "#eee",
  borderRadius: 999,
  padding: "1px 8px",
};
const activeBadge = {
  marginLeft: 8,
  fontSize: 11,
  color: "#fff",
  background: "#2F6FED",
  borderRadius: 999,
  padding: "1px 8px",
};
