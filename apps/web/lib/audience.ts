
import type { Audience } from "./api";

export const AUDIENCE_LABELS: Record<Audience, string> = {
  end_user: "利用者",
  planner: "企画者",
  developer: "開発者",
};

export const AUDIENCES: Audience[] = ["end_user", "planner", "developer"];
