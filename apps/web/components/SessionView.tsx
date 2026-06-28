"use client";

// セッション中の画面束（04/05/06 会話シェル → 07 判定 → 08 結果）。
// 会話体験 v2（ADR-0018 / Phase 6）の結線層。購読・整列・冪等・ハイドレーション・送信は
// useRealtimeSession に集約し、表示と画面遷移は ConversationSessionView（LiveKit 非依存）へ委ねる。
// 本層は LiveKit に触れる薄い接続部だけを持つ: マイク入力トグル・音声出力の消音・素材アップロード。

import { RoomAudioRenderer, useTrackToggle } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

import {
  ACCEPTED_IMAGE,
  ACCEPTED_VIDEO,
  exportRequirements,
  fetchContextFiles,
  finalizeSession,
  uploadContextFile,
  type ExportResult,
  type FinalizeResult,
} from "../lib/api";
import type { MaterialItem } from "../lib/realtime/selectors";
import { useRealtimeSession } from "../lib/realtime/useRealtimeSession";
import { ConversationSessionView } from "./ConversationSessionView";
import { MaterialSourceSheet } from "./MaterialSourceSheet";

export function SessionView({
  sessionId,
  sessionToken,
}: {
  sessionId: string;
  sessionToken: string | null;
}) {
  const { state, metrics, sendSelection, sendText, sendAnswer } = useRealtimeSession({
    sessionId,
    sessionToken,
    hydrateDetections: true,
  });

  // マイク入力（自分の声を拾うか）= LiveKit local track の ON/OFF。
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  // カメラ/画面共有の LiveKit ローカル映像トラック（ADR-0004）。05-2 手段選択シートから制御する
  // （旧 MaterialView の setCameraEnabled/setScreenShareEnabled 経路を新設計へ統合）。
  const camera = useTrackToggle({ source: Track.Source.Camera });
  const screenShare = useTrackToggle({ source: Track.Source.ScreenShare });
  // 音声出力（SANBA の読み上げ）の消音。RoomAudioRenderer の muted で実際に止める。
  const [muted, setMuted] = useState(false);
  // 05-2 手段選択シート（カメラ/アップロード/画面共有/Drive）の開閉と、カメラ/画面共有の
  // 開始失敗（権限拒否・ピッカーキャンセル）をシート上で示すためのエラー。
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  // 投入直後の素材ローカル行（uploading/failed）。realtime の analysis.progress/visual が届くまで、
  // また動画の「準備中」を可視化する橋渡し。
  const [pending, setPending] = useState<MaterialItem[]>([]);
  // #184: リロード/途中参加時に GET context/files で実ファイル名・状態を復元する。
  const [hydratedMaterials, setHydratedMaterials] = useState<MaterialItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const tempSeq = useRef(0);

  // 接続/再接続時に投入済み素材のメタを取り戻す（契約 §4 / #184）。失敗してもライブ差分で前進する。
  useEffect(() => {
    let alive = true;
    fetchContextFiles(sessionId, sessionToken)
      .then((snap) => {
        if (!alive) return;
        setHydratedMaterials(
          snap.items.map((f) => ({
            id: f.id,
            name: f.name,
            pct: f.status === "done" ? 100 : 0,
            status: f.status,
            ...(f.extracted ? { extracted: f.extracted } : {}),
          })),
        );
      })
      .catch(() => {
        /* ハイドレーションは補助。失敗してもライブ差分で前進する。 */
      });
    return () => {
      alive = false;
    };
  }, [sessionId, sessionToken]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルの再選択でも change を発火させる。
    if (!file) return;
    const tempId = `local:${tempSeq.current++}`;
    setPending((p) => [...p, { id: tempId, name: file.name, pct: 0, status: "uploading" }]);
    try {
      const res = await uploadContextFile(sessionId, file, sessionToken);
      // 成功: asset_id を確定する。画像は API で同期解析済み（analysis_pending=false）なので
      // done にする（画像は analysis.progress/visual のライブが来ないため analyzing のままだと
      // 「解析中100%」が残り、ミニ状況の解析中も消えない）。動画は解析未実装で analyzing のまま
      // （GET context/files のハイドレーションが状態を補正する / 契約 §3）。
      const assetId = res.asset_id ?? tempId;
      const done = res.analysis_pending !== true;
      setPending((p) =>
        p.map((m) =>
          m.id === tempId
            ? { id: assetId, name: file.name, pct: 100, status: done ? "done" : "analyzing" }
            : m,
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

  function openSourceSheet() {
    setSourceError(null);
    setSourceSheetOpen(true);
  }

  function handleRetryMaterial(id: string) {
    // 失敗行を片付けて手段選択をやり直す（05-2 シートを開く）。
    setPending((p) => p.filter((m) => m.id !== id));
    openSourceSheet();
  }

  // カメラ/画面共有の LiveKit ローカルトラックを開始/停止する。権限拒否や画面共有ピッカーの
  // キャンセルは toggle() の Promise 拒否として届くため、握りつぶさずシート上にエラーを出す
  // （旧 MaterialView と同じ扱い・観測のため console.error も残す）。
  async function toggleCameraTrack() {
    setSourceError(null);
    try {
      await camera.toggle();
    } catch (e) {
      console.error("camera toggle failed", e);
      setSourceError("カメラを開始できませんでした。ブラウザのカメラ許可をご確認ください。");
    }
  }

  async function toggleScreenShareTrack() {
    setSourceError(null);
    try {
      await screenShare.toggle();
    } catch (e) {
      // 画面共有ピッカーのキャンセルもここに届く（NotAllowedError）。
      console.error("screenShare toggle failed", e);
      setSourceError("画面共有を開始できませんでした。共有する画面を選び直してください。");
    }
  }

  function handleExport(): Promise<ExportResult> {
    return exportRequirements(sessionId, sessionToken);
  }

  function handleFinalize(): Promise<FinalizeResult> {
    // 07 判定の「確定」を永続化する（#186）。確定スナップショット（件数）を刻む。
    return finalizeSession(sessionId, sessionToken);
  }

  // テキスト送信は user.text（契約 §4.5 / #185）として agent へ会話ターンで届ける。
  // agent 側は発話として記録し（transcript.final で会話履歴にも反映）、応答を生成する。
  function handleSendText(text: string) {
    sendText(text);
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
        sendAnswer={sendAnswer}
        micOn={mic.enabled}
        muted={muted}
        onToggleMic={() => void mic.toggle()}
        onToggleMute={() => setMuted((m) => !m)}
        onSendText={handleSendText}
        onExport={handleExport}
        onFinalize={handleFinalize}
        onAddMaterial={openSourceSheet}
        extraMaterials={pending}
        hydratedMaterials={hydratedMaterials}
        onRetryMaterial={handleRetryMaterial}
        // 会話を離れる瞬間にローカル送信を止める（判定/結果ではボトムバーが無く止められないため）。
        // マイクに加え、映像トラック（カメラ/画面共有）も止めて帯域/コストを抑える（ADR-0004）。
        onLeaveConversation={() => {
          if (mic.enabled) void mic.toggle(false);
          if (camera.enabled) void camera.toggle(false);
          if (screenShare.enabled) void screenShare.toggle(false);
        }}
        onRestart={() => window.location.reload()}
        metrics={metrics}
      />

      {/*
        投入種別（camera/screen/upload/drive）の運用計測:
        - upload は API 側 `sanba_asset_uploads_total`（kind/result）で計上済み（observability.py）。
        - camera/screen は LiveKit ローカルトラックの publish としてサーバ側で観測できる。
        クライアントからの選択イベントを OTLP/メトリクス基盤へ束ねる収集先の設計は本 PR スコープ外のため
        #232 で対応する。MaterialSourceSheet 側に onSelectSource の seam を残し、そこへぶら下げる。
      */}
      {sourceSheetOpen && (
        <MaterialSourceSheet
          onClose={() => setSourceSheetOpen(false)}
          onUpload={() => {
            // アップロードは隠し input のピッカ → 既存の pending フロー（handleFile）へ合流。
            setSourceSheetOpen(false);
            fileInput.current?.click();
          }}
          onToggleCamera={toggleCameraTrack}
          cameraActive={camera.enabled}
          onToggleScreenShare={toggleScreenShareTrack}
          screenShareActive={screenShare.enabled}
          error={sourceError}
        />
      )}
    </>
  );
}
