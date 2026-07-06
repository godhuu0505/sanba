"use client";

// 05-2 素材の手段選択シート（カメラ撮影 / ファイルアップロード / 画面共有 / Google ドライブ）。
// 仕様: docs/design/conversation-experience.md §6 / docs/design/screens/05-materials.md（Figma 148:95）
//      / ADR-0004（マルチモーダル入力）/ ADR-0018。
//
// 設計ポイント:
// - SessionView 非依存の独立部品。02 準備（#222）でも再利用できるよう LiveKit には一切触れない。
//   カメラ/画面共有のローカルトラック制御は親（SessionView）がハンドラとして注入する
//   （ハンドラ未指定の文脈ではその導線を出さない）。これで旧 MaterialView の経路をここへ統合し、
//   二重実装を撤去する（#201 受け入れ基準）。
// - 投入種別（camera/screen/upload/drive）は onSelectSource で計測可能にする（CLAUDE.md 原則3）。
// - a11y: 暗幕＋ボトムシート（role=dialog/aria-modal）、ESC で閉じる、フォーカストラップ、
//   見た目に依らないラベル（ADR-0017）。
//
// Google ドライブは drive.file + Google Picker で取り込む（ADR-0040 / ADR-0007 の保留を解除）。
// 実導線は親が onDrive で注入する（EntryFlow / SessionView）。未注入の文脈では従来どおり
// 「準備中」を案内するフォールバックに退化する。

import { Camera, ChevronRight, Cloud, Monitor, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** 投入手段の種別（計測キー）。 */
export type MaterialSource = "camera" | "screen" | "upload" | "drive";

export interface MaterialSourceSheetProps {
  /** 閉じる（キャンセル / 暗幕 / ESC）。 */
  onClose: () => void;
  /** ファイルアップロードを選んだ（親がファイルピッカを開く）。 */
  onUpload: () => void;
  /**
   * カメラ撮影トグル（LiveKit ローカル映像トラック・ADR-0004）。
   * 未指定なら行を出さない（LiveKit ルーム外＝02 準備等で再利用するため）。
   */
  onToggleCamera?: () => void;
  cameraActive?: boolean;
  /**
   * 画面共有トグル（LiveKit ローカル映像トラック・ADR-0004）。
   * 未指定なら行を出さない。
   */
  onToggleScreenShare?: () => void;
  screenShareActive?: boolean;
  /**
   * Google ドライブ導線。ADR-0007 未承認のため既定は「準備中」を案内するだけ。
   * 実ピッカが用意できたら onDrive を注入して差し替える（別チケット）。
   */
  onDrive?: () => void;
  /**
   * 手段選択の計測フック（CLAUDE.md 原則3 / #201 投入種別の計測）。各導線の押下で発火する。
   * 運用での収集先（OTLP/メトリクス）への配線は #232。
   */
  onSelectSource?: (source: MaterialSource) => void;
  /** カメラ/画面共有の開始失敗（権限拒否・ピッカーキャンセル）を示す（親が制御）。 */
  error?: string | null;
  /**
   * 配置。既定は会話中のボトムシート（"bottom"）。02 準備では画面中央に出す（"center" / #222）。
   * ルーム外の準備画面はキーボード近接の必要が薄く、フォームの中で完結するダイアログとして
   * 中央に据える方が収まりが良い。
   */
  placement?: "bottom" | "center";
}

export function MaterialSourceSheet({
  onClose,
  onUpload,
  onToggleCamera,
  cameraActive,
  onToggleScreenShare,
  screenShareActive,
  onDrive,
  onSelectSource,
  error,
  placement = "bottom",
}: MaterialSourceSheetProps) {
  const centered = placement === "center";
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Drive 未承認（ADR-0007）の案内を押下時に開く。
  const [driveNotice, setDriveNotice] = useState(false);

  // 開いたらシート内へフォーカスを移す（a11y）。
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // ESC で閉じる＋Tab をシート内に閉じ込める（フォーカストラップ・a11y）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = sheetRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pick(source: MaterialSource, action?: () => void) {
    onSelectSource?.(source);
    action?.();
  }

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center ${
        centered ? "items-center px-4" : "items-end"
      }`}
    >
      {/* 暗幕（ChoicePin/AccountMenu 踏襲）。クリックで閉じる。 */}
      <button
        type="button"
        aria-label="閉じる（背景）"
        onClick={onClose}
        className="absolute inset-0 bg-sanba-frame/55"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="資料の追加方法"
        className={`relative z-10 flex w-full max-w-[420px] flex-col gap-2 border-sanba-frame bg-sanba-surface px-4 pb-[18px] pt-[14px] ${
          centered ? "rounded-[18px] border-2" : "rounded-t-[18px] border-t-2"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-sanba-gold-text">
            資料の追加方法を選ぶ
          </span>
          <span className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex size-[26px] items-center justify-center rounded-full border border-sanba-border bg-sanba-surface text-[12px] text-sanba-muted"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <p className="text-[12px] text-sanba-muted">
          言葉以外の情報（画像・画面・カメラ）も、会話を止めずに渡せます。
        </p>

        {onToggleCamera && (
          <SourceRow
            icon={<Camera size={20} />}
            title="カメラで撮影"
            sub="ホワイトボード／手書き（撮影して渡す）"
            active={cameraActive}
            actionLabel="カメラの起動/停止"
            onClick={() => pick("camera", onToggleCamera)}
          />
        )}

        <SourceRow
          icon={<Upload size={20} />}
          title="ファイルをアップロード"
          sub="写真（PNG/JPG）・録画（MP4/MOV）・資料（PDF/Office/Markdown/HTML/CSV 等）"
          onClick={() => pick("upload", onUpload)}
        />

        {onToggleScreenShare && (
          <SourceRow
            icon={<Monitor size={20} />}
            title={screenShareActive ? "画面共有を停止" : "画面を共有"}
            sub="ライブ（Figma 等）を一緒に見る"
            active={screenShareActive}
            actionLabel="画面共有の開始/停止"
            onClick={() => pick("screen", onToggleScreenShare)}
          />
        )}

        <SourceRow
          icon={<Cloud size={20} />}
          title="Google ドライブから選ぶ"
          sub="Google ドキュメント・スプレッドシート・スライドも取り込めます"
          onClick={() => pick("drive", onDrive ?? (() => setDriveNotice(true)))}
        />
        {driveNotice && !onDrive && (
          <p role="status" className="px-1 text-[11.5px] text-sanba-muted">
            Google ドライブ連携は準備中です（別チケット・ADR-0007）。今はファイルのアップロードをご利用ください。
          </p>
        )}

        {error && (
          <p role="alert" className="px-1 text-[11.5px] font-bold text-sanba-rec-text">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-1 rounded-[12px] border border-sanba-border py-[12px] text-center text-[13px] font-bold text-sanba-muted"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

function SourceRow({
  icon,
  title,
  sub,
  active,
  actionLabel,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  active?: boolean;
  /** 見た目（古語）に依らない現代語の機能ラベル（ADR-0017 / a11y）。 */
  actionLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={actionLabel}
      aria-pressed={active}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[12px] border bg-sanba-surface-strong px-3 py-[13px] text-left"
      style={{ borderColor: active ? "var(--sanba-gold-text)" : "var(--sanba-border)" }}
    >
      <span aria-hidden="true" className="text-[20px]">
        {icon}
      </span>
      <span className="flex flex-1 flex-col gap-[2px]">
        <span className="flex items-center gap-2 text-[14px] font-bold text-sanba-cream">
          {title}
          {active && (
            <span className="rounded-full bg-sanba-gold-text px-[7px] py-[1px] text-[10px] font-bold text-white">
              ON
            </span>
          )}
        </span>
        <span className="text-[11.5px] text-sanba-muted">{sub}</span>
      </span>
      <span aria-hidden="true" className="text-sanba-muted">
        <ChevronRight size={16} />
      </span>
    </button>
  );
}
