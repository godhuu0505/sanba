const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface CreateSessionResponse {
  session_id: string;
  invites: Record<string, string>;
}

export interface JoinResponse {
  token: string;
  livekit_url: string;
  session_id: string;
  identity: string;
}

export async function createSession(roles: string[]): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles }),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return res.json();
}

export async function joinSession(params: {
  invite: string;
  participantName: string;
}): Promise<JoinResponse> {
  const res = await fetch(`${API_URL}/api/sessions/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invite: params.invite,
      participant_name: params.participantName,
    }),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  return res.json();
}
