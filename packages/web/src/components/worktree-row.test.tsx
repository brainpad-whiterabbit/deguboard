// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewClient } from "../client/webview.js";
import { createHost, HostProvider } from "../host.js";
import { WorktreeRow } from "./worktree-row.js";

afterEach(cleanup);

describe("worktree の行", () => {
  it("ブラウザではパスだけを出し、新しいウィンドウで開くボタンは出さない", () => {
    render(
      <HostProvider host={createHost("browser", null)}>
        <WorktreeRow ticket="t1" path="/w/t1" />
      </HostProvider>,
    );
    expect(screen.getByText("/w/t1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新しいウィンドウで開く" })).toBeNull();
  });

  it("パネルではボタンが拡張ホストに頼み、頼みが失敗したら「開けない」を出す", async () => {
    const openWorktree = vi.fn(async () => {});
    const client = { openWorktree } as unknown as WebviewClient;
    render(
      <HostProvider host={createHost("panel", client)}>
        <WorktreeRow ticket="t1" path="/w/t1" />
      </HostProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "新しいウィンドウで開く" }));
    expect(openWorktree).toHaveBeenCalledWith("t1");
    openWorktree.mockRejectedValueOnce(new Error("x"));
    fireEvent.click(screen.getByRole("button", { name: "新しいウィンドウで開く" }));
    await waitFor(() => expect(screen.getByText("開けない")).toBeTruthy());
  });
});
