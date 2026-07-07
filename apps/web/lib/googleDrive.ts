"use client";

// Google ドライブ取り込み（ADR-0049）。drive.file スコープ + Google Picker の最小権限構成:
// ユーザーが Picker で選んだファイルだけにアクセス権が付き、Drive 全体は見えない。
//
// - Picker: 公式の選択 UI（https://apis.google.com/js/api.js → gapi.load("picker")）。
//   表示には API キー（NEXT_PUBLIC_GOOGLE_API_KEY）が必要。未設定ならこの連携ごと無効。
// - 取得: Google Docs/スプレッドシート/スライドは Drive API の export で
//   Markdown / xlsx / テキストへ変換して取り込む。それ以外（PDF・画像等）は alt=media で
//   そのまま落とし、既存のアップロード経路（POST context/file）へ合流させる。
// - トークンはメモリのみ（auth.tsx requestDriveAccess）。この module は保存しない。

import { classifyFileUpload } from "./api";

/** Picker を表示するための API キー。未設定なら Drive 連携は「利用できない」扱い。 */
const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

const GAPI_SRC = "https://apis.google.com/js/api.js";

// Google Workspace ネイティブ形式 → export 変換先（Drive API files.export）。
// - Docs: Markdown（見出し・箇条書きが残り、grounding のチャンク境界に効く）
// - スプレッドシート: xlsx（CSV export は先頭シートのみ。xlsx なら API 側で全シート抽出できる）
// - スライド: プレーンテキスト（本文抽出には十分で軽い）
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";

const EXPORT_PLANS: Record<string, { mime: string; ext: string }> = {
  [GOOGLE_DOC]: { mime: "text/markdown", ext: ".md" },
  [GOOGLE_SHEET]: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  [GOOGLE_SLIDES]: { mime: "text/plain", ext: ".txt" },
};

/** Picker に出すファイル種別（受理できるものだけ見せ、選んでから弾かれる体験を避ける）。 */
const PICKABLE_MIMES = [
  GOOGLE_DOC,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  "image/png",
  "image/jpeg",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

/** Picker で選ばれた 1 件（本 module が使う最小サブセット）。 */
export interface DrivePickedDoc {
  id: string;
  name: string;
  mimeType: string;
}

// Picker のグローバル（google.picker）。auth.tsx が window.google を別形で declare している
// ため、ここでは unknown 経由の最小ローカル型で読む（any は使わない / eslint 方針）。
interface PickerView {
  setMimeTypes(mimes: string): PickerView;
  setIncludeFolders(v: boolean): PickerView;
}

interface PickerBuilder {
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setLocale(locale: string): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setCallback(cb: (data: PickerCallbackData) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}

interface PickerCallbackData {
  action: string;
  docs?: { id: string; name: string; mimeType: string }[];
}

interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new () => PickerView;
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
}

/** Drive 連携がこの環境で構成済みか（API キー・client_id が揃っているか）。 */
export function isDriveConfigured(): boolean {
  return PICKER_API_KEY !== "" && CLIENT_ID !== "";
}

let pickerLoading: Promise<PickerNamespace | null> | null = null;

/** Picker ライブラリを一度だけ読み込む。失敗（オフライン等）は null で解決する。 */
function loadPicker(): Promise<PickerNamespace | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const existing = readPickerNamespace();
  if (existing) return Promise.resolve(existing);
  if (pickerLoading) return pickerLoading;
  pickerLoading = new Promise((resolve) => {
    const done = () => {
      const gapi = (window as unknown as { gapi?: { load(n: string, cb: () => void): void } })
        .gapi;
      if (!gapi) {
        resolve(null);
        return;
      }
      gapi.load("picker", () => resolve(readPickerNamespace()));
    };
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GAPI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    // すでにロード済み（load イベントを逃した）場合に備えた即時チェック。
    if ((window as unknown as { gapi?: unknown }).gapi) done();
  });
  return pickerLoading;
}

function readPickerNamespace(): PickerNamespace | null {
  const g = (window as unknown as { google?: { picker?: PickerNamespace } }).google;
  return g?.picker ?? null;
}

/**
 * Google Picker を開き、選ばれたファイルの一覧を返す（キャンセルは空配列）。
 * Picker の表示自体に失敗（未構成・スクリプト不達）したときは例外を投げ、呼び出し側が
 * 利用者向けの文言に変換する。
 */
export async function openDrivePicker(accessToken: string): Promise<DrivePickedDoc[]> {
  if (!isDriveConfigured()) throw new Error("drive_not_configured");
  const picker = await loadPicker();
  if (!picker) throw new Error("picker_load_failed");
  return new Promise((resolve) => {
    const view = new picker.DocsView().setMimeTypes(PICKABLE_MIMES).setIncludeFolders(false);
    new picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(PICKER_API_KEY)
      // appId は client_id の先頭（プロジェクト番号）。drive.file では選んだファイルへの
      // 権限付与をこのアプリに紐づけるために必要。
      .setAppId(CLIENT_ID.split("-")[0])
      .setLocale("ja")
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve(
            (data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })),
          );
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}

/** export/download の URL を組む（テストしやすいよう分離）。 */
export function driveFetchPlan(doc: DrivePickedDoc): { url: string; filename: string } {
  const plan = EXPORT_PLANS[doc.mimeType];
  if (plan) {
    return {
      url:
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export` +
        `?mimeType=${encodeURIComponent(plan.mime)}`,
      // export は形式が変わるため、拡張子を付けて受理判定（classify）と API 側の抽出を効かせる。
      filename: doc.name.endsWith(plan.ext) ? doc.name : `${doc.name}${plan.ext}`,
    };
  }
  return {
    url:
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}` +
      "?alt=media&supportsAllDrives=true",
    filename: doc.name,
  };
}

/**
 * 選ばれた 1 件をブラウザで取得して File にする。Google ネイティブ形式は export で変換、
 * それ以外はそのまま download。非対応形式（実体の MIME が受理外）は例外で知らせる。
 */
export async function importDriveFile(accessToken: string, doc: DrivePickedDoc): Promise<File> {
  const { url, filename } = driveFetchPlan(doc);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`drive fetch failed: ${res.status} (${doc.name})`);
  }
  const blob = await res.blob();
  const type = blob.type || doc.mimeType;
  const file = new File([blob], filename, { type });
  if (!classifyFileUpload(file)) {
    throw new Error(`unsupported drive file: ${doc.name}`);
  }
  return file;
}
