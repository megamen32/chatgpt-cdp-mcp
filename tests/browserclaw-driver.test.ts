import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpChatClient } from "../src/cdp-chat.js";
import { createCdpChatServer } from "../src/cdp-chat-mcp.js";
import {
  BROWSERCLAW_CDP_CHAT_CAPABILITIES,
  createBrowserClawCdpChatDriver,
  type BrowserClawToolClient,
} from "../src/browserclaw-driver.js";

function textResponse(text: string): Record<string, unknown> {
  return { result: { content: [{ type: "text", text }] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeBrowserClaw implements BrowserClawToolClient {
  readonly sessionRef = "browserclaw-test-session";
  readonly calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> = [];
  private readonly snapshots: string[];
  private snapshotIndex = 0;
  private chatGptOpen: boolean;
  private readonly foreignChatGpt: boolean;

  constructor(options: { chatGptOpen: boolean; foreignChatGpt?: boolean; snapshots?: string[] }) {
    this.chatGptOpen = options.chatGptOpen;
    this.foreignChatGpt = options.foreignChatGpt ?? false;
    this.snapshots = options.snapshots ?? [];
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ name, argumentsValue: structuredClone(argumentsValue) });
    if (name === "tabs") {
      if (argumentsValue.action === "new") {
        this.chatGptOpen = true;
        return textResponse("Opened page 42");
      }
      const tabs = [
        ...(this.foreignChatGpt ? ["[11] https://chatgpt.com/"] : []),
        ...(this.chatGptOpen ? ["[42] https://chatgpt.com/"] : []),
      ];
      return textResponse(tabs.length > 0 ? tabs.join("\n") : "[1] https://www.example.test/");
    }
    if (name === "snapshot") {
      if (this.foreignChatGpt && argumentsValue.page === 11) throw new Error("page is not owned by this BrowserClaw session");
      return textResponse(this.snapshots[this.snapshotIndex++] ?? this.snapshots.at(-1) ?? "textbox \"Message ChatGPT\" [ref=e-composer]");
    }
    if (name === "read") return textResponse("## Research result\nPrimary-source answer");
    if (name === "wait" || name === "act") return textResponse("ok");
    throw new Error(`unexpected BrowserClaw tool ${name}`);
  }
}

describe("bundled BrowserClaw driver", () => {
  it("creates one ChatGPT tab only when none exists, then retains that page", async () => {
    const browser = new FakeBrowserClaw({ chatGptOpen: false });
    const driver = await createBrowserClawCdpChatDriver({
      clientFactory: async () => browser,
      timeoutMs: 1_000,
    });

    const first = await driver.acquirePage();
    const second = await driver.acquirePage();
    expect((await first.identity()).pageRef).toBe("browserclaw-page:42");
    expect(await second.identity()).toEqual(await first.identity());
    expect(browser.calls.filter((call) => call.name === "tabs" && call.argumentsValue.action === "new")).toHaveLength(1);
    expect(browser.calls.filter((call) => call.name === "tabs" && call.argumentsValue.action === "new")[0]?.argumentsValue).toEqual({
      action: "new",
      url: "https://chatgpt.com/",
    });
  });

  it("reuses the existing ChatGPT tab for a new chat and research task", async () => {
    const browser = new FakeBrowserClaw({
      chatGptOpen: true,
      snapshots: [
        "textbox \"Message ChatGPT\" [ref=e-probe]",
        "button \"New chat\" [ref=e-new]",
        "textbox \"Message ChatGPT\" [ref=e-composer]",
        "button \"Tools\" [ref=e-tools]\ntextbox \"Message ChatGPT\" [ref=e-composer]",
        "menuitemcheckbox \"Deep Research\" [ref=e-research]\ntextbox \"Message ChatGPT\" [ref=e-composer]",
        "textbox \"Message ChatGPT\" [ref=e-composer]",
        "button \"Stop generating\" [ref=e-stop]\ntextbox \"Message ChatGPT\" [ref=e-composer]",
        "textbox \"Message ChatGPT\" [ref=e-composer]",
      ],
    });
    const driver = await createBrowserClawCdpChatDriver({ clientFactory: async () => browser, timeoutMs: 1_000 });
    const client = new CdpChatClient(driver);
    const fixture = await client.newChat({ confirmation: "NEW_CHAT", idempotencyKey: "browserclaw-fixture" });
    const result = await client.research({ chatRef: fixture.chatRef, prompt: "Compare two options" });

    expect(result.message.text).toContain("Research result");
    expect(browser.calls.filter((call) => call.name === "tabs" && call.argumentsValue.action === "new")).toHaveLength(0);
    const actions = browser.calls.filter((call) => call.name === "act").map((call) => call.argumentsValue);
    expect(actions).toEqual([
      { page: 42, kind: "click", ref: "e-new" },
      { page: 42, kind: "click", ref: "e-tools" },
      { page: 42, kind: "click", ref: "e-research" },
      { page: 42, kind: "fill", ref: "e-composer", value: "Compare two options" },
      { page: 42, kind: "press", key: "Enter" },
    ]);
    expect(browser.calls.find((call) => call.name === "read")?.argumentsValue).toEqual({
      page: 42,
      format: "markdown",
      selector: '[data-message-author-role="assistant"]:last-of-type',
      includeImages: false,
    });
  });

  it("does not select a visible ChatGPT page owned by another BrowserClaw session", async () => {
    const browser = new FakeBrowserClaw({ chatGptOpen: false, foreignChatGpt: true });
    const driver = await createBrowserClawCdpChatDriver({ clientFactory: async () => browser, timeoutMs: 1_000 });

    expect((await (await driver.acquirePage()).identity()).pageRef).toBe("browserclaw-page:42");
    expect(browser.calls.filter((call) => call.name === "snapshot" && call.argumentsValue.page === 11)).toHaveLength(1);
    expect(browser.calls.filter((call) => call.name === "tabs" && call.argumentsValue.action === "new")).toHaveLength(1);
  });

  it("accepts BrowserClaw's empty initialized-notification response", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(request);
      const headers = { "mcp-session-id": "browserclaw-live-shape" };
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }), { headers });
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      const tool = (request.params as { name?: string })?.name;
      if (tool === "tabs") return new Response(JSON.stringify(textResponse("[42] https://chatgpt.com/")), { headers });
      if (tool === "snapshot") return new Response(JSON.stringify(textResponse("textbox \"Message ChatGPT\" [ref=e-composer]")), { headers });
      throw new Error(`unexpected request ${String(request.method)}:${tool ?? ""}`);
    });

    const driver = await createBrowserClawCdpChatDriver({ endpoint: "http://browserclaw.test/mcp", timeoutMs: 1_000 });
    expect((await (await driver.acquirePage()).identity()).pageRef).toBe("browserclaw-page:42");
    expect(calls.map((call) => call.method)).toContain("notifications/initialized");
  });

  it("advertises only the operations the bundled driver implements", async () => {
    expect(BROWSERCLAW_CDP_CHAT_CAPABILITIES).toEqual({
      new_chat: true,
      list_chats: false,
      search_chat: false,
      export_chat: false,
      send_message: true,
      edit_message: false,
      download_media: true,
      research: true,
      search: true,
      draw: true,
    });

    const browser = new FakeBrowserClaw({ chatGptOpen: true });
    const driver = await createBrowserClawCdpChatDriver({ clientFactory: async () => browser, timeoutMs: 1_000 });
    const server = createCdpChatServer(driver);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "browserclaw-capability-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "download_media",
        "draw",
        "new_chat",
        "research",
        "search",
        "send_message",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
