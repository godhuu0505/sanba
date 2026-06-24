"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
} from "@livekit/components-react";
import { useState } from "react";
import {
  addSessionContext,
  createSession,
  joinSession,
  type JoinResponse,
} from "../lib/api";
import { useGoogleAuth } from "../lib/auth";
import { SessionView } from "../components/SessionView";

export default function Home() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("pm");
  const [context, setContext] = useState("");
  const [consent, setConsent] = useState(false);
  const [conn, setConn] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = useGoogleAuth();

  async function handleJoin() {
    try {
      setError(null);
      // Owner flow for the demo: create a session (with consent, issue #10),
      // optionally register reference material (RAG grounding, #6), then redeem
      // the role invite (#8). 本人確認は Google ログイン (ADR-0012)。
      const session = await createSession([role], consent, auth.credential);
      if (context.trim()) {
        await addSessionContext(session.session_id, context, "貼り付け資料");
      }
      const invite = session.invites[role];
      setConn(
        await joinSession({
          invite,
          participantName: name || auth.profile?.name || "ゲスト",
          idToken: auth.credential,
        }),
      );
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
          <h1 style={{ fontSize: 20 }}>🎙️ SANBA — 要件インタビュー中</h1>
          <p style={{ fontSize: 13, color: "#666" }}>
            セッション: <code>{conn.session_id}</code>
          </p>
          <SessionView sessionId={conn.session_id} sessionToken={conn.session_token} />
          <RoomAudioRenderer />
          <StartAudio label="🔊 音声を有効にする" />
        </main>
      </LiveKitRoom>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h1>🎙️ SANBA</h1>
      <p>解像度高く、要件を生み出す音声マルチエージェント。話しかけると、AIが一問ずつ質問し、要件を少しずつ明確にしていきます。</p>
      <LoginPanel auth={auth} />
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
      <button
        onClick={handleJoin}
        style={buttonStyle}
        disabled={!consent || !auth.loggedIn}
      >
        インタビューを始める
      </button>
      {!auth.loggedIn && (
        <p style={{ color: "#555", fontSize: 13 }}>
          開始するには、まず Google でログインしてください。
        </p>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}

function LoginPanel({ auth }: { auth: ReturnType<typeof useGoogleAuth> }) {
  const { loggedIn, profile, devMode, buttonRef, devSignIn, signOut } = auth;
  if (loggedIn) {
    return (
      <div style={loginBoxStyle}>
        <span>
          ✅ ログイン中: <strong>{profile?.email ?? "dev@sanba.local"}</strong>
        </span>
        <button onClick={signOut} style={linkButtonStyle}>
          ログアウト
        </button>
      </div>
    );
  }
  return (
    <div style={loginBoxStyle}>
      {devMode ? (
        <>
          <span style={{ fontSize: 13, color: "#555" }}>
            開発モード（GOOGLE_CLIENT_ID 未設定）。
          </span>
          <button onClick={devSignIn} style={buttonStyle}>
            開発用ログイン（bypass）
          </button>
        </>
      ) : (
        // GIS がこの div にログインボタンを描画する。
        <div ref={buttonRef} />
      )}
    </div>
  );
}

const inputStyle = { display: "block", width: "100%", padding: 8, margin: "6px 0 16px" };
const buttonStyle = { padding: "10px 16px", fontSize: 16, cursor: "pointer" };
const loginBoxStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap" as const,
  padding: "12px 0 4px",
  margin: "8px 0 16px",
  borderBottom: "1px solid #eee",
};
const linkButtonStyle = {
  background: "none",
  border: "none",
  color: "#1d76db",
  cursor: "pointer",
  textDecoration: "underline",
  padding: 0,
  fontSize: 14,
};
