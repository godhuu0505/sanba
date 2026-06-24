"use client";

// 06 素材を渡す — マルチモーダルの入口（Issue #103 / #98 / ADR-0004）。
//
// 言葉以外の情報（画像・動画・画面共有・カメラ）を渡す入口。
// - 画像アップロード: context/file へ送り asset_id を受け取る（#103 API 拡張）。非対応拡張子は弾く。
//   アップロード後の解析進捗は asset_id 経由で 08 解析（analysis.progress / analysis.visual）に対応付く。
// - 動画アップロード: 解析が未実装のため「準備中」でグレーアウトし誤操作を防ぐ（API は保存のみ対応）。
// - 画面共有・カメラ: 既存 LiveKit 映像トラック（API 追加不要）。

import { useLocalParticipant } from "@livekit/components-react";
import { useRef, useState } from "react";
import { ACCEPTED_IMAGE, classifyUpload, uploadContextFile } from "../lib/api";

interface UploadedAsset {
  asset_id: string;
  name: string;
  kind: "image" | "video";
}

export function MaterialView({ sessionId }: { sessionId: string }) {
  const { localParticipant } = useLocalParticipant();
  const [sharing, setSharing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedAsset[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    // 同じファイルを連続で選べるよう値はリセットする。
    e.target.value = "";
    if (!file) return;
    // ピッカの accept をすり抜けた非対応拡張子はここで弾く（API でも 415）。
    if (classifyUpload(file.name) !== "image") {
      setError("対応していない形式です。PNG または JPG を選んでください。");
      return;
    }
    setBusy(true);
    try {
      const res = await uploadContextFile(sessionId, file);
      if (res.asset_id) {
        setUploaded((prev) => [
          { asset_id: res.asset_id!, name: file.name, kind: "image" },
          ...prev,
        ]);
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

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

      {/* 画像: 隠し input をクリックで開く。非対応拡張子はピッカ accept + 上のガードで弾く。 */}
      <input
        ref={imageInput}
        type="file"
        accept={ACCEPTED_IMAGE}
        onChange={onImagePicked}
        style={{ display: "none" }}
        data-testid="image-input"
      />
      <MaterialRow
        icon="🖼"
        title={busy ? "アップロード中…" : "画像をアップロード"}
        sub="モック・スクショ・写真（PNG/JPG）"
        disabled={busy}
        onClick={() => imageInput.current?.click()}
      />
      {/* 動画解析は未実装（#103）。準備中でグレーアウトし誤操作を防ぐ。 */}
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

      {uploaded.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#444", marginBottom: 6 }}>
            アップロード済みの素材
          </div>
          {uploaded.map((a) => (
            <div key={a.asset_id} style={assetRow}>
              <span aria-hidden="true">🖼</span>
              <span style={{ flex: 1, fontSize: 14 }}>{a.name}</span>
              {/* asset_id で「解析」タブの analysis.* と対応付く（07/08）。 */}
              <span style={{ fontSize: 12, color: "#1F9E8B" }}>解析待ち</span>
            </div>
          ))}
          <p style={{ fontSize: 12, color: "#888", margin: "8px 0 0" }}>
            解析の進捗と結果は「解析」タブで確認できます。
          </p>
        </div>
      )}

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
  disabled,
}: {
  icon: string;
  title: string;
  sub: string;
  onClick?: () => void;
  pending?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  const off = pending || disabled;
  return (
    <button
      onClick={onClick}
      disabled={off}
      aria-disabled={off}
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
        background: off ? "#f6f6f6" : "#fff",
        color: off ? "#aaa" : "#222",
        cursor: off ? "not-allowed" : "pointer",
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
const assetRow = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 0",
  borderBottom: "1px solid #f2f2f2",
};
