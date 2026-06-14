"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  useVoiceAssistant,
  BarVisualizer,
} from "@livekit/components-react";
import { useState } from "react";
import {
  addSessionContext,
  createSession,
  joinSession,
  type JoinResponse,
} from "../lib/api";

export default function Home() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("pm");
  const [context, setContext] = useState("");
  const [consent, setConsent] = useState(false);
  const [conn, setConn] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    try {
      setError(null);
      // Owner flow for the demo: create a session (with consent, issue #10),
      // optionally register reference material (RAG grounding, #6), then redeem
      // the role invite (#8).
      const session = await createSession([role], consent);
      if (context.trim()) {
        await addSessionContext(session.session_id, context, "貼り付け資料");
      }
      const invite = session.invites[role];
      setConn(await joinSession({ invite, participantName: name || "ゲスト" }));
    } catch (e) {
      setError(String(e));
    }
  }

  if (conn) {
    return (
      <LiveKitRoom
        token={conn.token}
        serverUrl={conn.livekit_url}
        connect
        audio
        video={false}
        style={{ height: "100dvh" }}
      >
        <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
          <h1>🎙️ Kikitori — 要件インタビュー中</h1>
          <p>セッション: <code>{conn.session_id}</code></p>
          <InterviewView />
          <RoomAudioRenderer />
          <StartAudio label="🔊 音声を有効にする" />
        </main>
      </LiveKitRoom>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h1>🎙️ Kikitori</h1>
      <p>音声で要件を聞き取るマルチエージェント。話しかけると、AIが一問ずつ質問します。</p>
      <label>
        お名前
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
      </label>
      <label>
        役割
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="pm">PM</option>
          <option value="engineer">エンジニア</option>
          <option value="customer">顧客</option>
        </select>
      </label>
      <label>
        参考資料（任意・要件のヒントになる既存メモやPRDなど）
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={5}
          placeholder="ここに貼り付けた内容はAIが事前に読み込み、既知の事項は質問しません。"
          style={inputStyle}
        />
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", margin: "8px 0 16px" }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          会話の録音と AI による処理に同意します。発話・要件は最大{" "}
          {process.env.NEXT_PUBLIC_RETENTION_DAYS ?? "30"} 日保持され、保存前に個人情報はマスクされます。
        </span>
      </label>
      <button onClick={handleJoin} style={buttonStyle} disabled={!consent}>
        インタビューを始める
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}

function InterviewView() {
  const { state, audioTrack } = useVoiceAssistant();
  return (
    <div style={{ marginTop: 16 }}>
      <p>状態: {state}</p>
      <BarVisualizer state={state} trackRef={audioTrack} style={{ height: 96 }} />
    </div>
  );
}

const inputStyle = { display: "block", width: "100%", padding: 8, margin: "6px 0 16px" };
const buttonStyle = { padding: "10px 16px", fontSize: 16, cursor: "pointer" };
