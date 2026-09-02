import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCdpChatServer } from "../src/cdp-chat-mcp.js";
import type { ChatRecord, CdpChatDriver, CdpChatPage, DownloadedMedia, MessageRecord, PageIdentity } from "../src/cdp-chat.js";

const connections: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

class DemoPage implements CdpChatPage {
  private readonly identityValue: PageIdentity = {
    origin: "https://chatgpt.com",
    accountRef: "test-account",
    pageRef: "test-page",
    leaseRef: "test-lease",
  };
  private readonly chats: ChatRecord[] = [];

  async identity(): Promise<PageIdentity> { return structuredClone(this.identityValue); }
  async snapshot(): Promise<{ chats: ChatRecord[] }> { return { chats: structuredClone(this.chats) }; }
  async createChat(input: { title?: string }): Promise<ChatRecord> {
    const chat: ChatRecord = {
      id: "fixture-chat",
      title: input.title ?? "Disposable fixture",
      unread: false,
      working: false,
      updatedAt: "2026-08-12T00:00:00.000Z",
      messages: [],
    };
    this.chats.push(chat);
    return structuredClone(chat);
  }
  async sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord> {
    return { id: `${input.chatId}-message`, role: "user", text: input.text, version: 1, createdAt: "2026-08-12T00:00:00.000Z", media: [] };
  }
  async editMessage(): Promise<MessageRecord> { throw new Error("not used by this contract test"); }
  async downloadMedia(): Promise<DownloadedMedia> { throw new Error("not used by this contract test"); }
  async runTask(input: { chatId: string; kind: "research" | "search" | "draw"; prompt: string }): Promise<MessageRecord> {
    return {
      id: `${input.chatId}-${input.kind}-message`,
      role: "assistant",
      text: `${input.kind}: ${input.prompt}`,
      version: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      media: input.kind === "draw" ? [{ id: "generated-image", filename: "generated.png", mimeType: "image/png", size: 4 }] : [],
    };
  }
}

function driver(): CdpChatDriver {
  const page = new DemoPage();
  return { async acquirePage() { return page; } };
}

describe("standalone MCP server", () => {
  it("advertises the documented ten-tool contract and runs each ChatGPT task on its fixture", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCdpChatServer(driver());
    const client = new Client({ name: "chatgpt-cdp-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "download_media",
      "draw",
      "edit_message",
      "export_chat",
      "list_chats",
      "new_chat",
      "research",
      "search",
      "search_chat",
      "send_message",
    ]);

    const created = await client.callTool({
      name: "new_chat",
      arguments: { confirmation: "NEW_CHAT", idempotencyKey: "public-contract-test", title: "MCP fixture" },
    });
    const receipt = JSON.parse(String(created.content[0]?.type === "text" ? created.content[0].text : "{}")) as { chatRef?: string; fixture?: boolean };
    expect(receipt).toMatchObject({ fixture: true });
    expect(receipt.chatRef).toMatch(/^cdpchat:v1:chat:/);

    for (const [name, prompt] of [["research", "Compare options"], ["search", "Find sources"], ["draw", "Draw a diagram"]] as const) {
      const result = await client.callTool({ name, arguments: { chatRef: receipt.chatRef, prompt } });
      const body = JSON.parse(String(result.content[0]?.type === "text" ? result.content[0].text : "{}")) as { kind?: string; message?: { text?: string; media?: unknown[] } };
      expect(body).toMatchObject({ kind: name, message: { text: `${name}: ${prompt}` } });
      if (name === "draw") expect(body.message?.media).toHaveLength(1);
    }
  });

  it("returns an explicit capability error when a driver has no page-native task control", async () => {
    const page = new DemoPage();
    const noTaskPage: CdpChatPage = {
      identity: () => page.identity(),
      snapshot: () => page.snapshot(),
      createChat: (input) => page.createChat(input),
      sendMessage: (input) => page.sendMessage(input),
      editMessage: (input) => page.editMessage(input),
      downloadMedia: (input) => page.downloadMedia(input),
    };
    const noTaskDriver: CdpChatDriver = {
      async acquirePage() {
        return noTaskPage;
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCdpChatServer(noTaskDriver);
    const client = new Client({ name: "chatgpt-cdp-mcp-no-task-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });

    const created = await client.callTool({
      name: "new_chat",
      arguments: { confirmation: "NEW_CHAT", idempotencyKey: "no-task-fixture", title: "MCP fixture" },
    });
    const receipt = JSON.parse(String(created.content[0]?.type === "text" ? created.content[0].text : "{}")) as { chatRef?: string };
    const result = await client.callTool({ name: "research", arguments: { chatRef: receipt.chatRef, prompt: "Need research" } });
    expect(JSON.stringify(result)).toContain("task_not_supported");
  });

  it("starts when npm invokes the compiled CLI through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-cdp-mcp-bin-"));
    try {
      const compiled = join(process.cwd(), "dist", "cdp-chat-mcp.js");
      const bin = join(root, "chatgpt-cdp-mcp");
      await chmod(compiled, 0o755);
      await symlink(compiled, bin);
      const result = await execFileAsync("timeout", ["2s", bin], {
        env: { ...process.env, CDP_CHAT_DRIVER_MODULE: join(process.cwd(), "examples", "mock-driver.mjs") },
      }).catch((error: NodeJS.ErrnoException & { stderr?: string }) => error);
      expect(String(result.stderr ?? "")).toContain("MCP server running on stdio");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
