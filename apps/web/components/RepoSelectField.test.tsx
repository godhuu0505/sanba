// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ credential: "tok" }) }));

const getGithubLinkStatus = vi.fn();
const listGithubRepos = vi.fn();
const listGithubBranches = vi.fn();
vi.mock("@/lib/api", () => ({
  getGithubLinkStatus: (...a: unknown[]) => getGithubLinkStatus(...a),
  listGithubRepos: (...a: unknown[]) => listGithubRepos(...a),
  listGithubBranches: (...a: unknown[]) => listGithubBranches(...a),
}));

import { RepoSelectField, type RepoSelection } from "./RepoSelectField";

describe("RepoSelectField", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("未連携なら設定画面への導線を出す", async () => {
    getGithubLinkStatus.mockResolvedValue({ linked: false, github_login: null });
    render(<RepoSelectField value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/GitHub 未連携/)).toBeTruthy());
  });

  it("連携済みなら repo 一覧を出し、選択でデフォルトブランチを既定にする", async () => {
    getGithubLinkStatus.mockResolvedValue({ linked: true, github_login: "octo" });
    listGithubRepos.mockResolvedValue([
      { full_name: "octo/demo", default_branch: "main", private: true },
    ]);
    listGithubBranches.mockResolvedValue([
      { name: "dev", sha: "s1" },
      { name: "main", sha: "s2" },
    ]);
    const onChange = vi.fn<(s: RepoSelection | null) => void>();
    render(<RepoSelectField value={null} onChange={onChange} />);

    const repoSelect = await screen.findByLabelText("リポジトリ");
    fireEvent.change(repoSelect, { target: { value: "octo/demo" } });

    // branch を取得し、デフォルトブランチ(main)を既定選択して親へ伝える。
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ repo: "octo/demo", branch: "main" }),
    );
  });
});
