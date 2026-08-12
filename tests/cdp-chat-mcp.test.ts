import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCdpChatServer } from "../src/cdp-chat-mcp.js";
import type { ChatRecord, CdpChatDriver, CdpChatPage, DownloadedMedia, MessageRecord, PageIdentity } from "../src/cdp-chat.js";

const connections: Array<{ client: Client; server: { close(): Promise<void> } }> = [];

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
}

function driver(): CdpChatDriver {
  const page = new DemoPage();
  return { async acquirePage() { return page; } };
}

describe("standalone MCP server", () => {
  it("advertises the documented seven-tool contract and creates a fixture", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCdpChatServer(driver());
    const client = new Client({ name: "chatgpt-cdp-mcp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });

    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "download_media",
      "edit_message",
      "export_chat",
      "list_chats",
      "new_chat",
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
  });
});
