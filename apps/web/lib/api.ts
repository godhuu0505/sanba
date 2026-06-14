const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface JoinResponse {
  token: string;
  livekit_url: string;
  session_id: string;
  identity: string;
}

export async function joinSession(params: {
  participantName: string;
  role?: string;
  sessionId?: string;
}): Promise<JoinResponse> {
  const res = await fetch(`${API_URL}/api/sessions/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participant_name: params.participantName,
      role: params.role ?? "participant",
      session_id: params.sessionId,
    }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  return res.json();
}
