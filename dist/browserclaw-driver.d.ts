import { type CdpChatCapabilities, type CdpChatDriver } from "./cdp-chat.js";
export interface BrowserClawToolClient {
    readonly sessionRef: string;
    callTool(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<Record<string, unknown>>;
}
export interface BrowserClawCdpChatDriverOptions {
    endpoint?: string;
    token?: string;
    /** Reuse this one BrowserClaw page id. Omit to reuse one accessible ChatGPT tab or create one when none is accessible. */
    page?: number;
    timeoutMs?: number;
    clientFactory?: (deadlineAt: number) => Promise<BrowserClawToolClient>;
}
/** A capability set truthful for the bundled one-page BrowserClaw adapter. */
export declare const BROWSERCLAW_CDP_CHAT_CAPABILITIES: CdpChatCapabilities;
/** Connect a BrowserClaw MCP session, reuse an accessible ChatGPT tab, or create exactly one when none is accessible. */
export declare function createBrowserClawCdpChatDriver(options?: BrowserClawCdpChatDriverOptions): Promise<CdpChatDriver>;
