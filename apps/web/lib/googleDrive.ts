"use client";


import { classifyFileUpload } from "./api";

const PICKER_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

const GAPI_SRC = "https://apis.google.com/js/api.js";

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

export interface DrivePickedDoc {
  id: string;
  name: string;
  mimeType: string;
}

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

export function isDriveConfigured(): boolean {
  return PICKER_API_KEY !== "" && CLIENT_ID !== "";
}

let pickerLoading: Promise<PickerNamespace | null> | null = null;

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
    if ((window as unknown as { gapi?: unknown }).gapi) done();
  });
  return pickerLoading;
}

function readPickerNamespace(): PickerNamespace | null {
  const g = (window as unknown as { google?: { picker?: PickerNamespace } }).google;
  return g?.picker ?? null;
}

export async function openDrivePicker(accessToken: string): Promise<DrivePickedDoc[]> {
  if (!isDriveConfigured()) throw new Error("drive_not_configured");
  const picker = await loadPicker();
  if (!picker) throw new Error("picker_load_failed");
  return new Promise((resolve) => {
    const view = new picker.DocsView().setMimeTypes(PICKABLE_MIMES).setIncludeFolders(false);
    new picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(PICKER_API_KEY)
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

export function driveFetchPlan(doc: DrivePickedDoc): { url: string; filename: string } {
  const plan = EXPORT_PLANS[doc.mimeType];
  if (plan) {
    return {
      url:
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export` +
        `?mimeType=${encodeURIComponent(plan.mime)}`,
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
