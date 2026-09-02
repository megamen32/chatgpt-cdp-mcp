#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CdpChatClient, ALL_CDP_CHAT_CAPABILITIES, } from "./cdp-chat.js";
/** Return an MCP text result containing only bounded JSON data. */
function textResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
/** Register all standalone CDP website chat tools on one MCP server. */
export function registerCdpChatTools(server, client, capabilities = ALL_CDP_CHAT_CAPABILITIES) {
    if (capabilities.new_chat)
        server.tool("new_chat", "Create exactly one disposable chat on the owned authenticated page without submitting a prompt.", {
            confirmation: z.literal("NEW_CHAT"),
            idempotencyKey: z.string().min(1).max(128),
            title: z.string().min(1).max(256).optional(),
        }, async (args) => textResult(await client.newChat(args)));
    if (capabilities.list_chats)
        server.tool("list_chats", "List page-visible chats by explicit unread, observable working, or UTC-recent semantics with bounded pagination.", {
            view: z.enum(["unread", "working", "recent"]),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().max(128).optional(),
        }, async (args) => textResult(await client.listChats(args)));
    if (capabilities.search_chat)
        server.tool("search_chat", "Search page-visible chat titles and message text using one fresh owned-page snapshot.", {
            query: z.string().trim().min(1).max(256),
            limit: z.number().int().min(1).max(100).optional(),
        }, async (args) => textResult(await client.searchChat(args)));
    if (capabilities.export_chat)
        server.tool("export_chat", "Export one page-visible chat with bounded message count and UTF-8 byte output.", {
            chatRef: z.string().min(1).max(256),
            format: z.enum(["json", "markdown"]),
            maxMessages: z.number().int().min(1).max(100).optional(),
        }, async (args) => textResult(await client.exportChat(args)));
    if (capabilities.send_message)
        server.tool("send_message", "Send one message to a page-visible chat with exact confirmation SEND_MESSAGE and a one-shot idempotency gate.", {
            chatRef: z.string().min(1).max(256),
            text: z.string().min(1).max(100_000),
            confirmation: z.literal("SEND_MESSAGE"),
            idempotencyKey: z.string().min(1).max(128),
        }, async (args) => textResult(await client.sendMessage(args)));
    if (capabilities.edit_message)
        server.tool("edit_message", "Edit one fixture message only with exact confirmation EDIT_MESSAGE, one-shot idempotency, and an expected version or old-text guard.", {
            chatRef: z.string().min(1).max(256),
            messageRef: z.string().min(1).max(256),
            text: z.string().min(1).max(100_000),
            confirmation: z.literal("EDIT_MESSAGE"),
            idempotencyKey: z.string().min(1).max(128),
            expectedVersion: z.number().int().min(1).optional(),
            expectedText: z.string().max(100_000).optional(),
        }, async (args) => textResult(await client.editMessage(args)));
    if (capabilities.download_media)
        server.tool("download_media", "Download one fixture attachment of an allowlisted MIME and size into the confined media root.", {
            chatRef: z.string().min(1).max(256),
            messageRef: z.string().min(1).max(256),
            mediaRef: z.string().min(1).max(256),
            outputDir: z.string().max(4096).optional(),
        }, async (args) => textResult(await client.downloadMedia(args)));
    if (capabilities.research)
        server.tool("research", "Run one deep-research-style prompt in the disposable fixture chat through the owned ChatGPT page. The configured driver must implement the page's research control.", {
            chatRef: z.string().min(1).max(256),
            prompt: z.string().trim().min(1).max(100_000),
        }, async (args) => textResult(await client.research(args)));
    if (capabilities.search)
        server.tool("search", "Run one web-search-style prompt in the disposable fixture chat through the owned ChatGPT page. The configured driver must implement the page's web search control.", {
            chatRef: z.string().min(1).max(256),
            prompt: z.string().trim().min(1).max(100_000),
        }, async (args) => textResult(await client.search(args)));
    if (capabilities.draw)
        server.tool("draw", "Run one image-generation prompt in the disposable fixture chat through the owned ChatGPT page. Generated media returns as opaque downloadable refs when the driver exposes it.", {
            chatRef: z.string().min(1).max(256),
            prompt: z.string().trim().min(1).max(100_000),
        }, async (args) => textResult(await client.draw(args)));
}
/** Create the standalone MCP server around an already configured page driver. */
export function createCdpChatServer(driver, options = {}) {
    const server = new McpServer({
        name: "cdp-website-chat",
        version: "0.1.0",
        description: "Bounded ChatGPT chat operations over one owned CDP page",
    });
    registerCdpChatTools(server, new CdpChatClient(driver, options), driver.capabilities ?? ALL_CDP_CHAT_CAPABILITIES);
    return server;
}
/** Load a BrowserClaw/CDP driver factory from an explicit local module path. */
export async function loadCdpChatDriver(modulePath = process.env.CDP_CHAT_DRIVER_MODULE) {
    const selectedDriver = process.env.CDP_CHAT_DRIVER?.trim();
    if (selectedDriver === "browserclaw") {
        const { createBrowserClawCdpChatDriver } = await import("./browserclaw-driver.js");
        return createBrowserClawCdpChatDriver();
    }
    if (selectedDriver && selectedDriver !== "module") {
        throw new Error("CDP_CHAT_DRIVER must be browserclaw or module");
    }
    if (!modulePath)
        throw new Error("CDP_CHAT_DRIVER_MODULE must point to the BrowserClaw/CDP driver module");
    const resolved = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
    const loaded = await import(pathToFileURL(resolved).href);
    const factory = loaded.createCdpChatDriver ?? loaded.default;
    if (!factory)
        throw new Error("CDP driver module must export createCdpChatDriver or a default factory");
    const driver = await factory();
    if (!driver || typeof driver.acquirePage !== "function")
        throw new Error("CDP driver factory returned an invalid driver");
    return driver;
}
/** Start the stdio MCP process used by the standalone route. */
export async function main() {
    const driver = await loadCdpChatDriver();
    const server = createCdpChatServer(driver, {
        mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT,
    });
    await server.connect(new StdioServerTransport());
    console.error("[cdp-website-chat] MCP server running on stdio");
}
/** npm invokes package bins through a symlink, so resolve the executable target. */
function isEntrypoint() {
    if (!process.argv[1])
        return false;
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    }
    catch {
        return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    }
}
if (isEntrypoint()) {
    main().catch((error) => {
        console.error(`[cdp-website-chat] Fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
