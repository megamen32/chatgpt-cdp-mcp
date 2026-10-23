/**
 * Chrome DevTools Protocol driver for one user-owned ChatGPT page.
 *
 * The driver talks to a Chrome the user already runs. It needs no BrowserClaw,
 * no launchd/launchctl, no OS-level automation and no Accessibility scripting:
 * the only channel is the browser DevTools WebSocket.
 *
 * Two connection routes are supported:
 *
 *   1. the toggle route (real profile). Chrome 136+ ignores
 *      `--remote-debugging-port` for the default user-data-dir, so a real
 *      profile is reachable only through "Allow remote debugging for this
 *      browser instance" at `chrome://inspect/#remote-debugging`. Chrome then
 *      serves only the browser WebSocket and answers 404 on every HTTP
 *      discovery endpoint. The endpoint is read from
 *      `<user-data-dir>/DevToolsActivePort` and the ownership of that port is
 *      proved from the argv profile and the socket owner (see
 *      `./chrome-cdp-owner.js`).
 *
 *   2. the flag route (separate profile). Chrome started with
 *      `--remote-debugging-port` and a non-default `--user-data-dir` answers
 *      `/json/*`; the same browser WebSocket is used, and the endpoint may be
 *      given directly.
 *
 * Everything the driver does happens inside the one ChatGPT page it attaches
 * to: it reads the sidebar and the rendered conversation, and it types into
 * the composer of the page it owns.
 */
import type { CdpChatCapabilities, CdpChatDriver } from "./cdp-chat.js";
import { type SocketOwnerProbe } from "./chrome-cdp-owner.js";
/** A capability set truthful for the Chrome CDP page driver. */
export declare const CHROME_CDP_CHAT_CAPABILITIES: CdpChatCapabilities;
/** Minimal WebSocket seam, so tests can drive the driver without a browser. */
export interface WebSocketConnection {
    send(data: string): void;
    close(): void;
    onOpen(listener: () => void): void;
    onMessage(listener: (data: string) => void): void;
    onClose(listener: () => void): void;
    onError(listener: (error: Error) => void): void;
}
/** Factory that opens one WebSocket to a DevTools endpoint. */
export type WebSocketFactory = (url: string) => WebSocketConnection;
/** Open a WebSocket to a DevTools endpoint with the standard `ws` client. */
export declare const defaultWebSocketFactory: WebSocketFactory;
/** Options accepted by {@link createChromeCdpCdpChatDriver}. */
export interface ChromeCdpDriverOptions {
    /** Chrome user-data-dir that owns the DevTools port. */
    readonly profileDir?: string;
    /** Explicit browser WebSocket URL, bypassing DevToolsActivePort discovery. */
    readonly browserWsUrl?: string;
    /** Skip the ownership proof when the endpoint is given explicitly. */
    readonly requireOwnership?: boolean;
    /** Attach to this exact page target id instead of the only ChatGPT page. */
    readonly targetId?: string;
    /** Override the socket owner lookup. */
    readonly ownershipProbe?: SocketOwnerProbe;
    /** Override the WebSocket client. */
    readonly webSocketFactory?: WebSocketFactory;
    /** Deadline for one browser operation. */
    readonly timeoutMs?: number;
}
/** A refusal raised by the Chrome CDP driver. */
export declare class ChromeCdpError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string);
}
/** Decide whether one URL belongs to ChatGPT. */
export declare function isChatGptUrl(value: string): boolean;
/** Extract the conversation id from a ChatGPT conversation URL. */
export declare function conversationIdFromUrl(value: string): string | undefined;
/**
 * Create the Chrome CDP driver.
 *
 * The driver connects lazily: the MCP server starts even when Chrome is not
 * running, and every operation then refuses with the concrete reason.
 */
export declare function createChromeCdpCdpChatDriver(options?: ChromeCdpDriverOptions): Promise<CdpChatDriver & {
    close(): void;
}>;
