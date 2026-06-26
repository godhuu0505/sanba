"use client";

// セッション中の画面束（04/05/06 会話シェル → 07 判定 → 08 結果）。
// 会話体験 v2（ADR-0018 / Phase 6）の結線層。購読・整列・冪等・ハイドレーション・送信は
// useRealtimeSession に集約し、表示と画面遷移は ConversationSessionView（LiveKit 非依存）へ委ねる。
// 本層は LiveKit に触れる薄い接続部だけを持つ: マイク入力トグル・音声出力の消音・素材アップロード。

import { RoomAudioRenderer, useTrackToggle } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useRef, useState } from "react";

import {
  ACCEPTED_IMAGE,
  ACCEPTED_VIDEO,
  addSessionContext,
  exportRequirements,
  uploadContextFile,
  type ExportResult,
} from "../lib/api";
import type { MaterialItem } from "../lib/realtime/selectors";
import { useRealtimeSession } from "../lib/realtime/useRealtimeSession";
import { ConversationSessionView } from "./ConversationSessionView";

export function SessionView({
  sessionId,
  sessionToken,
}: {
  sessionId: string;
  sessionToken: string | null;
}) {
  const { state, metrics, sendSelection } = useRealtimeSession({
    sessionId,
    sessionToken,
    hydrateDetections: true,
  });

  // マイク入力（自分の声を拾うか）= LiveKit local track の ON/OFF。
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  // 音声出力（SANBA の読み上げ）の消音。RoomAudioRenderer の muted で実際に止める。
  const [muted, setMuted] = useState(false);

  // 投入直後の素材ローカル行（uploading/failed）。realtime の analysis.progress/visual が届くまで、
  // また動画の「準備中」を可視化する橋渡し。#184（GET context/files）導入でハイドレーションへ寄せる。
  const [pending, setPending] = useState<MaterialItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const tempSeq = useRef(0);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルの再選択でも change を発火させる。
    if (!file) return;
    const tempId = `local:${tempSeq.current++}`;
    setPending((p) => [...p, { id: tempId, name: file.name, pct: 0, status: "uploading" }]);
    try {
      const res = await uploadContextFile(sessionId, file, sessionToken);
      // 成功: asset_id を確定し解析待ちへ。以後 analysis.progress が同 asset_id で届けば
      // realtime 行が前面化し、このローカル行は重複排除で隠れる（契約 §3）。
      const assetId = res.asset_id ?? tempId;
      setPending((p) =>
        p.map((m) =>
          m.id === tempId ? { id: assetId, name: file.name, pct: 100, status: "analyzing" } : m,
        ),
      );
    } catch (err) {
      // 失敗（415/413/ネットワーク）は沈黙させず行を failed にし、再試行導線を出す。
      console.error("material upload failed", err);
      const reason = err instanceof Error ? err.message : "アップロードに失敗しました";
      setPending((p) =>
        p.map((m) => (m.id === tempId ? { ...m, name: `${file.name}（${reason}）`, status: "failed" } : m)),
      );
    }
  }

  function handleRetryMaterial(id: string) {
    // 失敗行を片付けて手段選択（当面はファイル選択）をやり直す。
    setPending((p) => p.filter((m) => m.id !== id));
    fileInput.current?.click();
  }

  function handleExport(): Promise<ExportResult> {
    return exportRequirements(sessionId, sessionToken);
  }

  // テキスト送信は #185（user.text）未実装のため、当面はセッション文脈へ投入して
  // 会話に反映させる（捨て足場ではなく実効果のある暫定動線。#185 で会話ターン化する）。
  function handleSendText(text: string) {
    void addSessionContext(sessionId, text, sessionToken, "user_text").catch((e) =>
      console.warn("text relay failed", e),
    );
  }

  return (
    <>
      <RoomAudioRenderer muted={muted} />
      <input
        ref={fileInput}
        type="file"
        accept={`${ACCEPTED_IMAGE},${ACCEPTED_VIDEO}`}
        onChange={handleFile}
        className="hidden"
      />
      <ConversationSessionView
        state={state}
        sendSelection={sendSelection}
        micOn={mic.enabled}
        muted={muted}
        onToggleMic={() => void mic.toggle()}
        onToggleMute={() => setMuted((m) => !m)}
        onSendText={handleSendText}
        onExport={handleExport}
        onAddMaterial={() => fileInput.current?.click()}
        extraMaterials={pending}
        onRetryMaterial={handleRetryMaterial}
        // 会話を離れる瞬間にマイク送信を止める（判定/結果ではボトムバーが無く止められないため）。
        onLeaveConversation={() => {
          if (mic.enabled) void mic.toggle(false);
        }}
        onRestart={() => window.location.reload()}
        metrics={metrics}
      />
    </>
  );
}
