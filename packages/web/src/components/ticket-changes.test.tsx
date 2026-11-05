// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewClient } from "../client/webview.js";
import { createHost, HostProvider } from "../host.js";
import { StoreProvider } from "../store.js";
import { mockClient } from "../test-helpers.js";
import type { BranchChanges } from "../types.js";
import { TicketChanges } from "./ticket-changes.js";

afterEach(cleanup);

const changes: BranchChanges = {
  branch: "feat/x",
  base_ref: "origin/main",
  head_ref: "feat/x",
  base_commit: "aaa",
  head_commit: "bbb",
  files: [
    { kind: "added", path: "新しい.md", old_path: null, additions: 3, deletions: 0, binary: false },
    { kind: "modified", path: "a.ts", old_path: null, additions: 2, deletions: 1, binary: false },
    { kind: "deleted", path: "old.txt", old_path: null, additions: 0, deletions: 4, binary: false },
    { kind: "renamed", path: "b.ts", old_path: "c.ts", additions: 0, deletions: 0, binary: false },
    {
      kind: "added",
      path: "img.png",
      old_path: null,
      additions: null,
      deletions: null,
      binary: true,
    },
  ],
};

function renderChanges(host = createHost("browser", null), data: () => unknown = () => changes) {
  const client = mockClient();
  client.handlers["ticket.changes"] = data;
  render(
    <StoreProvider client={client}>
      <HostProvider host={host}>
        <TicketChanges ticket="t1" />
      </HostProvider>
    </StoreProvider>,
  );
  return client;
}

describe("チケット詳細の変更", () => {
  it("押すまで読まず、押すと種類の印と行数つきの一覧を出す。ブラウザではファイルを押せない", async () => {
    const client = renderChanges();
    expect(client.calls.some((c) => c.name === "ticket.changes")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "変更を見る" }));
    await screen.findByText("新しい.md");
    expect(client.calls.find((c) => c.name === "ticket.changes")?.input).toEqual({ ticket: "t1" });
    const rows = [...document.querySelectorAll(".changes-file")].map((r) => r.textContent);
    expect(rows).toEqual([
      "A新しい.md+3 −0",
      "Ma.ts+2 −1",
      "Dold.txt+0 −4",
      "Rc.ts → b.ts+0 −0",
      "Aimg.pngバイナリ",
    ]);
    expect(document.querySelector(".change-deleted")?.getAttribute("title")).toBe("削除");
    expect(screen.getByText(/5 ファイル/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /差分を開く/ })).toBeNull();
    expect(document.querySelectorAll("button.changes-file")).toHaveLength(0);
  });

  it("Webview ではファイルを押すと、一覧で読んだコミットつきで差分を開くよう拡張ホストに頼む", async () => {
    const openDiff = vi.fn(async () => {});
    renderChanges(createHost("panel", { openDiff } as unknown as WebviewClient));
    fireEvent.click(screen.getByRole("button", { name: "変更を見る" }));
    fireEvent.click(await screen.findByTitle("b.ts の差分を開く"));
    expect(openDiff).toHaveBeenCalledWith({
      ticket: "t1",
      path: "b.ts",
      old_path: "c.ts",
      base_commit: "aaa",
      head_commit: "bbb",
    });
    openDiff.mockRejectedValueOnce(new Error("x"));
    fireEvent.click(screen.getByTitle("a.ts の差分を開く"));
    await waitFor(() => expect(screen.getByText("差分を開けない")).toBeTruthy());
  });

  it("ブランチが見つからなければ理由を出し、一覧を出さない", async () => {
    renderChanges(undefined, () => {
      throw new Error(
        "ブランチ feat/x がローカルにもリモートの追跡ブランチにもないので、変更を出せない",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "変更を見る" }));
    await screen.findByText(/ローカルにもリモートの追跡ブランチにもない/);
    expect(document.querySelector(".changes-list")).toBeNull();
  });
});
