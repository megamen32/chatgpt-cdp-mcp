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
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
export const READ_ONLY_TOKEN_CAPABILITIES = {
    list_chats: true,
    search_chat: true,
    export_chat: true,
    new_chat: false,
    send_message: false,
    edit_message: false,
    download_media: false,
    research: false,
    search: false,
    draw: false,
};
const BASE_URL = "https://chatgpt.com";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
/** Persistent bridge process: one JSON request per stdin line, one JSON reply per line. */
class BridgeTransport {
    command;
    child = null;
    pending = [];
    buffer = "";
    constructor(command) {
        this.command = command;
    }
    request(url, headers) {
        return new Promise((resolve, reject) => {
            this.ensure();
            const timeout = setTimeout(() => {
                const index = this.pending.indexOf(handler);
                if (index >= 0)
                    this.pending.splice(index, 1);
                reject(new Error("token bridge timed out"));
            }, 60_000);
            const handler = (envelope) => {
                clearTimeout(timeout);
                resolve(envelope);
            };
            this.pending.push(handler);
            this.child?.stdin?.write(JSON.stringify({ url, headers }) + "\n");
        });
    }
    ensure() {
        if (this.child)
            return;
        this.child = spawn("/bin/sh", ["-c", this.command], { stdio: ["pipe", "pipe", "ignore"] });
        this.child.stdout?.setEncoding("utf-8");
        this.child.stdout?.on("data", (chunk) => {
            this.buffer += chunk;
            let index = this.buffer.indexOf("\n");
            while (index >= 0) {
                const line = this.buffer.slice(0, index).trim();
                this.buffer = this.buffer.slice(index + 1);
                if (line) {
                    const handler = this.pending.shift();
                    if (handler) {
                        try {
                            handler(JSON.parse(line));
                        }
                        catch {
                            // ignore malformed bridge lines
                        }
                    }
                }
                index = this.buffer.indexOf("\n");
            }
        });
        this.child.on("exit", () => {
            this.child = null;
        });
    }
}
function epochMs(value) {
    if (typeof value === "string" && value.trim())
        return Date.parse(value) || 0;
    if (typeof value === "number" && Number.isFinite(value))
        return value * 1000;
    return 0;
}
function epochToIso(value) {
    if (typeof value === "string" && value.trim()) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        const date = new Date(value * 1000);
        return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
    }
    return "1970-01-01T00:00:00.000Z";
}
export class TokenCdpChatPage {
    options;
    bridge;
    accessToken = null;
    cookieJar;
    constructor(sessionToken, options, bridge) {
        this.options = options;
        this.bridge = bridge;
        this.cookieJar = { "__Secure-next-auth.session-token": sessionToken };
    }
    async identity() {
        await this.ensureToken();
        return {
            origin: BASE_URL,
            accountRef: this.options.accountId ?? "token-session",
            pageRef: "token-session",
            leaseRef: "token-session",
        };
    }
    async snapshot() {
        const token = await this.ensureToken();
        const list = await this.httpGetJson(`/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false`, { Authorization: `Bearer ${token}` });
        const items = (Array.isArray(list.items) ? list.items : [])
            .slice()
            .sort((left, right) => epochMs(right.update_time ?? right.create_time) - epochMs(left.update_time ?? left.create_time));
        // Full message trees cost one request per chat: load the newest N in
        // detail and keep the rest as list metadata.
        const depth = Math.max(1, this.options.snapshotDepth ?? 10);
        const delay = Math.max(0, this.options.detailDelayMs ?? 1200);
        const detailed = new Map();
        for (const item of items.slice(0, depth)) {
            if (delay > 0)
                await new Promise((resolve) => setTimeout(resolve, delay));
            try {
                detailed.set(item.id, await this.httpGetJson(`/backend-api/conversation/${encodeURIComponent(item.id)}`, { Authorization: `Bearer ${token}` }));
            }
            catch {
                // leave the chat as metadata-only when its detail request fails
            }
        }
        const chats = items.map((item) => {
            const conversation = detailed.get(item.id);
            const mapping = conversation?.mapping ?? {};
            const messages = Object.values(mapping)
                .map((node) => node.message)
                .filter((message) => Boolean(message))
                .filter((message) => message.author?.role !== "system")
                .map((message) => {
                const parts = message.content?.parts ?? [];
                const text = parts
                    .map((part) => (typeof part === "string" ? part : `[${String(part.content_type ?? "asset")}]`))
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
                return {
                    id: `${item.id}:${epochToIso(message.create_time ?? item.update_time ?? item.create_time)}`,
                    role: message.author?.role ?? "assistant",
                    text,
                    version: 1,
                    createdAt: epochToIso(message.create_time ?? item.update_time ?? item.create_time),
                    media: [],
                };
            })
                .filter((message) => message.text.length > 0)
                .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
            return {
                id: item.id,
                title: item.title ?? "ChatGPT",
                unread: false,
                working: false,
                updatedAt: epochToIso(item.update_time ?? item.create_time),
                messages,
            };
        });
        return { chats };
    }
    async createChat() {
        throw new Error("token driver is read-only; use a CDP driver to create chats");
    }
    async sendMessage() {
        throw new Error("token driver is read-only; use a CDP driver to send messages");
    }
    async editMessage() {
        throw new Error("token driver is read-only; use a CDP driver to edit messages");
    }
    async downloadMedia() {
        throw new Error("token driver is read-only; use a CDP driver to download media");
    }
    async ensureToken() {
        if (this.accessToken)
            return this.accessToken;
        const session = await this.httpGetJson("/api/auth/session", {}, true);
        const token = String(session.accessToken ?? "");
        if (!token)
            throw new Error("session cookie was rejected: no accessToken in /api/auth/session");
        this.accessToken = token;
        return token;
    }
    async httpGetJson(path, headers = {}, sessionAuth = false) {
        const url = path.startsWith("http") ? path : BASE_URL + path;
        const requestHeaders = {
            "User-Agent": USER_AGENT, "Accept": "application/json", ...headers,
        };
        if (Object.keys(this.cookieJar).length > 0) {
            requestHeaders["Cookie"] = Object.entries(this.cookieJar)
                .map(([name, value]) => `${name}=${value}`).join("; ");
        }
        let status = 0;
        let body = "";
        if (this.options.fetchCommand && this.bridge) {
            ({ status, body } = await this.bridge.request(url, requestHeaders));
        }
        else if (this.options.fetchImpl) {
            const response = await this.options.fetchImpl(url, { headers: requestHeaders });
            status = response.status;
            body = await response.text();
        }
        else {
            const response = await fetch(url, { headers: requestHeaders });
            status = response.status;
            body = await response.text();
        }
        if (status !== 200) {
            throw new Error(`ChatGPT returned HTTP ${status} for ${url.split("?")[0]}`);
        }
        return JSON.parse(body);
    }
}
function readSessionToken(options) {
    const fromEnv = (options.sessionToken ?? process.env.CHATGPT_TOKEN_SESSION_TOKEN ?? "").trim();
    if (fromEnv)
        return fromEnv;
    const file = options.sessionFile ?? process.env.CHATGPT_TOKEN_SESSION_FILE ?? "";
    if (file.trim()) {
        const state = JSON.parse(readFileSync(file.trim(), "utf-8"));
        const token = String(state.session_token ?? state.sessionToken ?? "").trim();
        if (token)
            return token;
    }
    throw new Error("token driver requires CHATGPT_TOKEN_SESSION_TOKEN or CHATGPT_TOKEN_SESSION_FILE");
}
export async function createTokenCdpChatDriver(options = {}) {
    const depth = Number.parseInt(process.env.CHATGPT_TOKEN_SNAPSHOT_DEPTH ?? "", 10);
    const resolved = {
        ...options,
        sessionToken: options.sessionToken ?? process.env.CHATGPT_TOKEN_SESSION_TOKEN,
        sessionFile: options.sessionFile ?? process.env.CHATGPT_TOKEN_SESSION_FILE,
        accountId: options.accountId ?? process.env.CHATGPT_TOKEN_ACCOUNT_ID,
        fetchCommand: options.fetchCommand ?? process.env.CHATGPT_TOKEN_FETCH_COMMAND,
        snapshotDepth: options.snapshotDepth ?? (Number.isFinite(depth) ? depth : 10),
        detailDelayMs: options.detailDelayMs ?? (() => {
            const parsed = Number.parseInt(process.env.CHATGPT_TOKEN_DETAIL_DELAY_MS ?? "", 10);
            return Number.isFinite(parsed) ? parsed : 1200;
        })(),
    };
    const sessionToken = readSessionToken(resolved);
    const bridge = resolved.fetchCommand ? new BridgeTransport(resolved.fetchCommand) : null;
    const page = new TokenCdpChatPage(sessionToken, resolved, bridge);
    return {
        capabilities: READ_ONLY_TOKEN_CAPABILITIES,
        acquirePage: async () => page,
    };
}
