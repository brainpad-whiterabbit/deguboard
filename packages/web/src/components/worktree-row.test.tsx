// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WebviewClient } from "../client/webview.js";
import { createHost, HostProvider } from "../host.js";
import { WorktreeRow } from "./worktree-row.js";

afterEach(cleanup);

describe("worktree の行", () => {
  it.each([["拡張ホストとつながっていない（dg serve）", null]])(
    "%sとき、パスとコピーのボタンだけを出す",
    (_, client: WebviewClient | null) => {
      render(
        <HostProvider host={createHost("panel", client)}>
          <WorktreeRow path="/w/t1" />
        </HostProvider>,
      );
      expect(screen.getByText("/w/t1")).toBeTruthy();
      expect(screen.getByRole("button", { name: "worktree のパスをコピー" })).toBeTruthy();
      expect(screen.getAllByRole("button")).toHaveLength(1);
    },
  );
});
