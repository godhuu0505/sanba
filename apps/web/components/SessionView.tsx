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
import { useRealtimeSession } from "../lib/realtime/useRealtimeSession";
import { ConversationSessionView } from "./ConversationSessionView";

export function SessionView({
  sessionId,
  sessionToken,
}: {
  sessionId: string;
  sessionToken: string | null;
}) {
  const { state, sendSelection } = useRealtimeSession({
    sessionId,
    sessionToken,
    hydrateDetections: true,
  });

  // マイク入力（自分の声を拾うか）= LiveKit local track の ON/OFF。
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  // 音声出力（SANBA の読み上げ）の消音。RoomAudioRenderer の muted で実際に止める。
  const [muted, setMuted] = useState(false);

  // 「＋ 素材を追加」: 隠し input でファイルを選ばせ、context/file へアップロードする（#103）。
  // 返却 asset_id に対し analysis.progress/visual が届き、参考資料タブへ反映される（契約 §3）。
  const fileInput = useRef<HTMLInputElement>(null);
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルの再選択でも change を発火させる。
    if (!file) return;
    try {
      await uploadContextFile(sessionId, file, sessionToken);
    } catch {
      // 失敗は #184（GET context/files）導入時に行状態へ反映する。当面は握りつぶさず再試行可能に保つ。
    }
  }

  function handleExport(): Promise<ExportResult> {
    return exportRequirements(sessionId, sessionToken);
  }

  // テキスト送信は #185（user.text）未実装のため、当面はセッション文脈へ投入して
  // 会話に反映させる（捨て足場ではなく実効果のある暫定動線。#185 で会話ターン化する）。
  function handleSendText(text: string) {
    void addSessionContext(sessionId, text, sessionToken, "user_text");
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
        onRestart={() => window.location.reload()}
      />
    </>
  );
}
