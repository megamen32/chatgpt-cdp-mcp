#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CdpChatClient, type CdpChatDriver } from "./cdp-chat.js";
/** Register all standalone CDP website chat tools on one MCP server. */
export declare function registerCdpChatTools(server: McpServer, client: CdpChatClient): void;
/** Create the standalone MCP server around an already configured page driver. */
export declare function createCdpChatServer(driver: CdpChatDriver, options?: ConstructorParameters<typeof CdpChatClient>[1]): McpServer;
/** Load a BrowserClaw/CDP driver factory from an explicit local module path. */
export declare function loadCdpChatDriver(modulePath?: string | undefined): Promise<CdpChatDriver>;
/** Start the stdio MCP process used by the standalone route. */
export declare function main(): Promise<void>;
