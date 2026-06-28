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
  // #219: 中断で破棄した素材の id 集合。mergeMaterials で表示・件数から除き、遅延 analysis.* が
  // 来ても行を復活させないガード（realtime 契約・サーバ取消は触らずクライアント側の破棄に留める）。
  const [cancelledIds, setCancelledIds] = useState<ReadonlySet<string>>(() => new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const tempSeq = useRef(0);
  // 送信中アップロードの AbortController（tempId→controller）。中断時に abort() で fetch を中止する。
  const uploadAborters = useRef<Map<string, AbortController>>(new Map());
  // アップロード成功で行 id は tempId→asset_id に差し替わる（realtime と突き合わせるため）。
  // 確認ダイアログを tempId で開いた直後に成功すると、確定時は古い tempId が渡る。両 id を
  // 中断対象に解決できるよう tempId↔asset_id の対応（一意）を保持する（#219 / Codex P2）。
  // MaterialsList の中断確認も、表示名ではなくこの一意対応で id 差し替え後の行を追跡するため
  // state で持ち、props として配る（同名素材の取り違えを防ぐ）。
  const [uploadAliases, setUploadAliases] = useState<ReadonlyMap<string, string>>(() => new Map());

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
    // 中断（#219）で送信中の fetch を止められるよう AbortController を紐づける。
    const aborter = new AbortController();
    uploadAborters.current.set(tempId, aborter);
    setPending((p) => [...p, { id: tempId, name: file.name, pct: 0, status: "uploading" }]);
    try {
      const res = await uploadContextFile(sessionId, file, sessionToken, aborter.signal);
      // 中断確定後に成功応答が届く通信レース（abort 直前にレスポンスが解決済みだと catch を通らない）。
      // 成功を反映しない（行は handleCancelMaterial が立てた cancelled のまま＝破棄を維持）。
      // ここで res.asset_id を破棄ガードへ積まないこと: asset_id は内容ハッシュで安定するため
      // 同一ファイルを再投入すると同じ id になり、古い中断応答が後から再投入済みの行を隠してしまう
      // （Codex P2）。サーバに作られた asset の取消／再読込をまたぐ整合は #245（クライアントは
      // tempId の cancelled 行で表示破棄に留める）。
      if (aborter.signal.aborted) return;
      // 成功: asset_id を確定する。画像は API で同期解析済み（analysis_pending=false）なので
      // done にする（画像は analysis.progress/visual のライブが来ないため analyzing のままだと
      // 「解析中100%」が残り、ミニ状況の解析中も消えない）。動画は解析未実装で analyzing のまま
      // （GET context/files のハイドレーションが状態を補正する / 契約 §3）。
      const assetId = res.asset_id ?? tempId;
      const done = res.analysis_pending !== true;
      // tempId↔asset_id を控える（確認ダイアログを tempId で開いた後に成功しても中断できるように）。
      if (assetId !== tempId) {
        setUploadAliases((prev) => new Map(prev).set(tempId, assetId));
      }
      // 成功で abort 対象ではなくなったので controller を片付ける（中断は破棄ガードに切替わる）。
      uploadAborters.current.delete(tempId);
      // 明示的な再投入は復活させる（#219 / Codex P2）。API は内容ハッシュで安定 asset_id を返すため
      // （storage.compute_asset_id）、中断後に同じファイルを再追加すると asset_id が前回の破棄
      // tombstone と一致してしまう。成功時に当該 asset_id を破棄ガードから外す。
      setCancelledIds((prev) => {
        if (!prev.has(assetId)) return prev;
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
      // 画像は同期解析済みなので done/100%。動画は解析未着手の「準備中」なので analyzing/0%
      // にして「解析中100%」を出さない。pct はハイドレーション（status→ done?100:0）と揃える。
      setPending((p) =>
        p
          // 同 asset_id の古い破棄 tombstone を取り除く（status 由来の除外が再投入を巻き込まないように）。
          .filter((m) => !(m.id === assetId && m.id !== tempId && m.status === "cancelled"))
          .map((m) =>
            m.id === tempId
              ? {
                  id: assetId,
                  name: file.name,
                  pct: done ? 100 : 0,
                  status: done ? "done" : "analyzing",
                }
              : m,
          ),
      );
    } catch (err) {
      // 中断（#219）による abort は失敗ではない。handleCancelMaterial が行を cancelled にして
      // 破棄済みなので、ここでは failed に上書きしない（途中までの結果を破棄したまま終える）。
      if (aborter.signal.aborted) return;
      // 失敗（415/413/ネットワーク）は沈黙させず行を failed にし、再試行導線を出す。
      console.error("material upload failed", err);
      const reason = err instanceof Error ? err.message : "アップロードに失敗しました";
      setPending((p) =>
        p.map((m) => (m.id === tempId ? { ...m, name: `${file.name}（${reason}）`, status: "failed" } : m)),
      );
    } finally {
      uploadAborters.current.delete(tempId);
    }
  }

  // 解析/アップロード中の素材を中断して破棄する（#219）。
  // - アップロード中: 送信中の fetch を AbortController.abort() で中止する。
  // - 解析中（realtime/動画準備中）: ローカル行を cancelled にし、id を cancelledIds へ積む。
  // cancelledIds により、破棄後に遅延 analysis.* が届いても mergeMaterials が行を復活させない。
  // サーバ側の解析ジョブ取消は Out of Scope（必要なら別 issue）。クライアントの破棄に留める。
  function handleCancelMaterial(id: string) {
    // 確認ダイアログを tempId で開いた後にアップロードが成功すると行 id は asset_id に変わる。
    // どちらで渡されても確実に破棄できるよう、tempId↔asset_id の対応を双方向に解決する（Codex P2）。
    const ids = new Set<string>([id]);
    const aliased = uploadAliases.get(id);
    if (aliased) ids.add(aliased);
    for (const [tempId, assetId] of uploadAliases) if (assetId === id) ids.add(tempId);

    let aborted = false;
    for (const cid of ids) {
      const controller = uploadAborters.current.get(cid);
      if (controller) {
        controller.abort(); // 送信中の fetch を中止する。
        aborted = true;
        uploadAborters.current.delete(cid);
      }
    }
    // ローカル行があれば cancelled にする（pending の failed 行管理を踏襲した終端状態）。
    setPending((p) => p.map((m) => (ids.has(m.id) ? { ...m, status: "cancelled" } : m)));
    // realtime/復元由来の行（pending に無い）も含めて id を無視するガードに積む。
    setCancelledIds((prev) => {
      const next = new Set(prev);
      for (const cid of ids) next.add(cid);
      return next;
    });
    // 観測性（CLAUDE.md 原則3）: 中断率・abort 有無・対象 id を運用で追えるよう記録する。
    // 投入種別計測（#201 onSelectSource）と同じく、OTLP/メトリクス基盤への集約配線は #232。
    console.info("[material] cancel", { ids: [...ids], aborted });
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
        onCancelMaterial={handleCancelMaterial}
        cancelledIds={cancelledIds}
        materialAliases={uploadAliases}
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
