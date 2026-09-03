/**
 * Read-only ChatGPT driver backed by the session-cookie token exchange.
 *
 * The long-lived `__Secure-next-auth.session-token` cookie (renewed whenever
 * the account owner is active in any browser) is exchanged for a short-lived
 * `accessToken` at `https://chatgpt.com/api/auth/session`, and that token
 * drives the `backend-api` conversation endpoints. This reproduces the exact
 * traffic a normal logged-in browser produces, without a browser.
 *
 * Cloudflare fronts chatgpt.com and rejects non-browser TLS fingerprints
 * (plain Node fetch gets 403), so when the plain global `fetch` is rejected,
 * point `CHATGPT_TOKEN_FETCH_COMMAND` at a bridge command that performs the
 * request with a browser-grade TLS stack (e.g. the bundled
 * `examples/token_bridge.py`, which uses `curl_cffi`). The bridge receives
 * `{"url": ..., "headers": {...}}` as a single JSON line on stdin and answers
 * with `{"status": ..., "body": "...", "cookies": {...}}` as one JSON line on
 * stdout; cookies returned by the server are fed back into subsequent calls.
 *
 * Read-only by design: `new_chat`, `send_message`, `edit_message`,
 * `download_media`, `research`, and `draw` are not declared in capabilities.
 */
import type { ChatRecord, ChatSnapshot, CdpChatCapabilities, CdpChatDriver, CdpChatPage, DownloadedMedia, MessageRecord, PageIdentity } from "./cdp-chat.js";
export declare const READ_ONLY_TOKEN_CAPABILITIES: CdpChatCapabilities;
export interface TokenDriverOptions {
    sessionToken?: string;
    sessionFile?: string;
    accountId?: string;
    fetchCommand?: string;
    fetchImpl?: typeof fetch;
    snapshotDepth?: number;
    detailDelayMs?: number;
}
interface BridgeEnvelope {
    status: number;
    body: string;
    cookies?: Record<string, string>;
}
/** Persistent bridge process: one JSON request per stdin line, one JSON reply per line. */
declare class BridgeTransport {
    private readonly command;
    private child;
    private readonly pending;
    private buffer;
    constructor(command: string);
    request(url: string, headers: Record<string, string>): Promise<BridgeEnvelope>;
    private ensure;
}
export declare class TokenCdpChatPage implements CdpChatPage {
    private readonly options;
    private readonly bridge;
    private accessToken;
    private readonly cookieJar;
    constructor(sessionToken: string, options: {
        accountId?: string;
        fetchImpl?: typeof fetch;
        fetchCommand?: string;
        snapshotDepth?: number;
        detailDelayMs?: number;
    }, bridge: BridgeTransport | null);
    identity(): Promise<PageIdentity>;
    snapshot(): Promise<ChatSnapshot>;
    createChat(): Promise<ChatRecord>;
    sendMessage(): Promise<MessageRecord>;
    editMessage(): Promise<MessageRecord>;
    downloadMedia(): Promise<DownloadedMedia>;
    private ensureToken;
    private httpGetJson;
}
export declare function createTokenCdpChatDriver(options?: TokenDriverOptions): Promise<CdpChatDriver & {
    capabilities: CdpChatCapabilities;
}>;
export {};
