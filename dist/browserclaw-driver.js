import { createHash, randomUUID } from "node:crypto";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const DEFAULT_ENDPOINT = "http://127.0.0.1:9010/mcp";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESULT_BYTES = 64 * 1024;
const ACTIONABLE_TASK_ROLES = new Set(["button", "menuitem", "menuitemcheckbox", "option"]);
const MODE_PATTERNS = {
    research: /(?:deep\s*research|research|глубок(?:ое|ий)\s+исслед|исследован)/iu,
    search: /(?:web\s*search|search\s+(?:the\s+)?web|^search$|(?:веб[- ]?)?поиск)/iu,
    draw: /(?:create\s+(?:an\s+)?image|image\s+generation|^image$|^draw$|создать\s+изображ|генерац(?:ия|ию)\s+изображ|нарисовать|рисунок)/iu,
};
const NEW_CHAT_PATTERN = /^(?:new\s+chat|новый\s+чат)$/iu;
const TOOLS_PATTERN = /^(?:tools?|инструменты|more\s+tools|ещё\s+инструменты)$/iu;
const COMPOSER_PATTERN = /(?:chat\s+with\s+chatgpt|message\s+chatgpt|сообщени(?:е|я)|чат\s+с\s+chatgpt)/iu;
const STREAMING_PATTERN = /(?:stop\s+(?:generating|response)|cancel\s+(?:response|generation)|остановить|прервать\s+генерац)/iu;
/** A capability set truthful for the bundled one-page BrowserClaw adapter. */
export const BROWSERCLAW_CDP_CHAT_CAPABILITIES = {
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
};
/** Connect a BrowserClaw MCP session, reuse an accessible ChatGPT tab, or create exactly one when none is accessible. */
export async function createBrowserClawCdpChatDriver(options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1000) {
        throw new Error("CDP_CHAT_BROWSERCLAW_TIMEOUT_MS must be an integer from 1000 to 3600000");
    }
    const configuredPage = options.page ?? parseOptionalPage(process.env.CDP_CHAT_BROWSERCLAW_PAGE);
    const client = options.clientFactory
        ? await options.clientFactory(deadline(timeoutMs))
        : await BrowserClawStreamableClient.connect(options.endpoint ?? process.env.CDP_CHAT_BROWSERCLAW_MCP_URL ?? DEFAULT_ENDPOINT, deadline(timeoutMs), (options.token ?? process.env.CDP_CHAT_BROWSERCLAW_MCP_TOKEN?.trim()) || undefined);
    const page = configuredPage ?? await selectOrOpenChatGptPage(client, deadline(timeoutMs));
    if (configuredPage !== undefined)
        await assertAccessibleChatGptPage(client, page, deadline(timeoutMs));
    const owned = new BrowserClawChatPage(client, page, timeoutMs);
    await owned.assertLease();
    return {
        capabilities: BROWSERCLAW_CDP_CHAT_CAPABILITIES,
        async acquirePage() {
            await owned.assertLease();
            return owned;
        },
    };
}
/** Small persistent Streamable-HTTP client for BrowserClaw's public MCP surface. */
class BrowserClawStreamableClient {
    endpoint;
    token;
    sessionId;
    requestId = 1;
    constructor(endpoint, token) {
        this.endpoint = endpoint;
        this.token = token;
    }
    static async connect(endpoint, deadlineAt, token) {
        const client = new BrowserClawStreamableClient(endpoint, token);
        const response = await client.post({
            jsonrpc: "2.0",
            id: client.requestId++,
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "chatgpt-cdp-mcp", version: "0.1.0" },
            },
        }, deadlineAt);
        if (response.error || !client.sessionId)
            throw new Error("BrowserClaw MCP initialization failed");
        await client.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, deadlineAt, true);
        return client;
    }
    get sessionRef() {
        if (!this.sessionId)
            throw new Error("BrowserClaw MCP session is not initialized");
        return this.sessionId;
    }
    async callTool(name, argumentsValue, deadlineAt) {
        const response = await this.post({
            jsonrpc: "2.0",
            id: this.requestId++,
            method: "tools/call",
            params: { name, arguments: argumentsValue },
        }, deadlineAt);
        if (response.error)
            throw new Error(`BrowserClaw rejected ${name}`);
        const result = response.result;
        if (!isRecord(result) || result.isError === true) {
            const detail = textContent(response).trim();
            throw new Error(`BrowserClaw reported ${name} failed${detail ? `: ${detail}` : ""}`);
        }
        return response;
    }
    async post(body, deadlineAt, allowEmptyResponse = false) {
        const headers = {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-03-26",
        };
        if (this.sessionId)
            headers["mcp-session-id"] = this.sessionId;
        if (this.token)
            headers.authorization = `Bearer ${this.token}`;
        const response = await fetch(this.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(remainingMs(deadlineAt)),
        });
        const nextSession = response.headers.get("mcp-session-id");
        if (nextSession)
            this.sessionId = nextSession;
        if (!response.ok)
            throw new Error(`BrowserClaw MCP request failed with HTTP ${response.status}`);
        const responseBody = await response.text();
        if (!responseBody.trim() && allowEmptyResponse)
            return {};
        return parseJsonRpcBody(responseBody);
    }
}
/** BrowserClaw-backed implementation that keeps one page lease after initial acquisition. */
class BrowserClawChatPage {
    client;
    page;
    timeoutMs;
    identityValue;
    created;
    generatedMedia = new Map();
    constructor(client, page, timeoutMs) {
        this.client = client;
        this.page = page;
        this.timeoutMs = timeoutMs;
        const digest = createHash("sha256").update(`${client.sessionRef}:${page}`).digest("hex").slice(0, 24);
        this.identityValue = {
            origin: CHATGPT_ORIGIN,
            accountRef: `browserclaw:${digest}`,
            pageRef: `browserclaw-page:${page}`,
            leaseRef: `browserclaw-lease:${digest}`,
        };
    }
    async identity() {
        return this.identityValue;
    }
    async snapshot() {
        await this.assertLease();
        return { chats: this.created ? [structuredClone(this.created)] : [] };
    }
    async createChat(input) {
        if (this.created)
            return structuredClone(this.created);
        const snapshot = await this.a11ySnapshot();
        const newChat = findNode(snapshot.nodes, (node) => ["button", "link"].includes(node.role) && NEW_CHAT_PATTERN.test(node.name ?? ""));
        if (!newChat)
            throw new Error("ChatGPT New chat control was not found on the owned page; refusing to reuse an existing conversation");
        await this.act({ kind: "click", ref: newChat.ref });
        await this.waitForComposer();
        const createdAt = new Date().toISOString();
        this.created = {
            id: `browserclaw-fixture:${randomUUID()}`,
            title: input.title?.trim() || "ChatGPT CDP MCP disposable chat",
            unread: false,
            working: false,
            updatedAt: createdAt,
            messages: [],
        };
        return structuredClone(this.created);
    }
    async sendMessage(input) {
        const chat = this.requireFixture(input.chatId);
        await this.submitPrompt(input.text);
        const result = {
            id: `browserclaw-user:${randomUUID()}`,
            role: "user",
            text: input.text,
            version: 1,
            createdAt: new Date().toISOString(),
            media: [],
        };
        chat.messages.push(result);
        chat.updatedAt = result.createdAt;
        return structuredClone(result);
    }
    async editMessage() {
        throw new Error("The bundled BrowserClaw driver does not implement edit_message");
    }
    async downloadMedia(input) {
        const chat = this.requireFixture(input.chatId);
        const message = chat.messages.find((entry) => entry.id === input.messageId);
        if (!message || !message.media.some((entry) => entry.id === input.mediaId))
            throw new Error("generated media is not bound to this fixture message");
        const downloaded = this.generatedMedia.get(input.mediaId);
        if (!downloaded)
            throw new Error("generated media bytes are no longer available in this BrowserClaw driver");
        return { ...downloaded, bytes: downloaded.bytes.slice() };
    }
    async runTask(input) {
        const chat = this.requireFixture(input.chatId);
        await this.selectTaskMode(input.kind);
        await this.submitPrompt(input.prompt);
        await this.waitForCompletion();
        const text = await this.readLatestAssistantResult();
        const media = input.kind === "draw" ? await this.captureDrawScreenshot() : [];
        const result = {
            id: `browserclaw-${input.kind}:${randomUUID()}`,
            role: "assistant",
            text,
            version: 1,
            createdAt: new Date().toISOString(),
            media,
        };
        chat.messages.push(result);
        chat.updatedAt = result.createdAt;
        return structuredClone(result);
    }
    async assertLease() {
        const tabs = await listTabs(this.client, deadline(this.timeoutMs));
        const owned = tabs.find((entry) => entry.page === this.page);
        if (!owned || !isChatGptUrl(owned.url))
            throw new Error("BrowserClaw page lease was lost; the owned ChatGPT tab disappeared or navigated away");
    }
    requireFixture(chatId) {
        if (!this.created || this.created.id !== chatId)
            throw new Error("chat is not the disposable fixture created on the owned BrowserClaw page");
        return this.created;
    }
    async a11ySnapshot() {
        await this.assertLease();
        const response = await this.client.callTool("snapshot", { page: this.page, mode: "full", depth: 100 }, deadline(this.timeoutMs));
        const text = textContent(response);
        if (!text.trim())
            throw new Error("BrowserClaw returned an empty accessibility snapshot");
        return { text, nodes: parseA11yNodes(text) };
    }
    async selectTaskMode(kind) {
        let snapshot = await this.a11ySnapshot();
        let control = findTaskControl(snapshot.nodes, kind);
        if (!control) {
            const tools = findNode(snapshot.nodes, (node) => node.role === "button" && TOOLS_PATTERN.test(node.name ?? ""));
            if (!tools)
                throw new Error(`ChatGPT ${kind} control is not visible and the Tools menu was not found on the owned page`);
            await this.act({ kind: "click", ref: tools.ref });
            snapshot = await this.a11ySnapshot();
            control = findTaskControl(snapshot.nodes, kind);
        }
        if (!control)
            throw new Error(`ChatGPT ${kind} capability is not available to the owned page/account`);
        await this.act({ kind: "click", ref: control.ref });
    }
    async submitPrompt(prompt) {
        const snapshot = await this.a11ySnapshot();
        const composer = findComposer(snapshot.nodes);
        if (!composer)
            throw new Error("ChatGPT composer was not found on the owned page");
        await this.act({ kind: "fill", ref: composer.ref, value: prompt });
        await this.act({ kind: "press", key: "Enter" });
    }
    async waitForComposer() {
        const until = deadline(this.timeoutMs);
        while (Date.now() < until) {
            const snapshot = await this.a11ySnapshot();
            if (findComposer(snapshot.nodes))
                return;
            await this.waitBriefly(until);
        }
        throw new Error("ChatGPT composer did not become available on the owned page");
    }
    async waitForCompletion() {
        const until = deadline(this.timeoutMs);
        let sawStreaming = false;
        let attempts = 0;
        while (Date.now() < until) {
            const snapshot = await this.a11ySnapshot();
            const streaming = STREAMING_PATTERN.test(snapshot.text);
            sawStreaming ||= streaming;
            if ((sawStreaming || attempts >= 1) && !streaming && findComposer(snapshot.nodes))
                return snapshot;
            attempts += 1;
            await this.waitBriefly(until);
        }
        throw new Error("ChatGPT task did not finish before the BrowserClaw deadline");
    }
    async waitBriefly(until) {
        await this.client.callTool("wait", {
            page: this.page,
            for: "time",
            timeout: Math.min(1_000, remainingMs(until)),
            value: 500,
        }, until);
    }
    async act(action) {
        await this.client.callTool("act", { page: this.page, ...action }, deadline(this.timeoutMs));
    }
    async readLatestAssistantResult() {
        try {
            const response = await this.client.callTool("read", {
                page: this.page,
                format: "markdown",
                selector: '[data-message-author-role="assistant"]:last-of-type',
                includeImages: false,
            }, deadline(this.timeoutMs));
            const result = textContent(response).trim();
            if (result)
                return truncateUtf8(result, MAX_RESULT_BYTES);
        }
        catch {
            // A UI update can remove this optional DOM hook; the safe fallback below
            // keeps the page's surrounding chat history out of the MCP response.
        }
        try {
            const response = await this.client.callTool("evaluate", {
                page: this.page,
                code: `const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')]; return messages.at(-1)?.innerText?.trim() ?? "";`,
                timeout: Math.min(30_000, this.timeoutMs),
            }, deadline(this.timeoutMs));
            const result = textContent(response).trim();
            if (result)
                return truncateUtf8(result, MAX_RESULT_BYTES);
        }
        catch {
            // Do not fall back to an unscoped page read or full a11y tree.
        }
        return "ChatGPT task settled in the owned page, but its final assistant text could not be extracted.";
    }
    async captureDrawScreenshot() {
        try {
            const response = await this.client.callTool("screenshot", {
                page: this.page,
                format: "png",
                fullPage: false,
                size: { width: 1440, height: 1024 },
            }, deadline(this.timeoutMs));
            const image = imageContent(response);
            if (!image)
                return [];
            const bytes = Buffer.from(image.data, "base64");
            if (bytes.byteLength === 0)
                return [];
            const id = `browserclaw-draw:${randomUUID()}`;
            const filename = "chatgpt-draw-result.png";
            this.generatedMedia.set(id, { bytes, filename, mimeType: image.mimeType });
            return [{ id, filename, mimeType: image.mimeType, size: bytes.byteLength }];
        }
        catch {
            // The generated image remains visible in ChatGPT even when a screenshot is unavailable.
            return [];
        }
    }
}
function deadline(timeoutMs) {
    return Date.now() + timeoutMs;
}
function remainingMs(deadlineAt) {
    return Math.max(1, deadlineAt - Date.now());
}
function parseOptionalPage(value) {
    if (!value?.trim())
        return undefined;
    const page = Number(value);
    if (!Number.isSafeInteger(page) || page < 0)
        throw new Error("CDP_CHAT_BROWSERCLAW_PAGE must be a non-negative integer");
    return page;
}
async function selectOrOpenChatGptPage(client, deadlineAt) {
    const candidates = (await listTabs(client, deadlineAt)).filter((entry) => isChatGptUrl(entry.url));
    const accessible = [];
    for (const candidate of candidates) {
        try {
            await assertAccessibleChatGptPage(client, candidate.page, deadlineAt);
            accessible.push(candidate);
        }
        catch (error) {
            if (!isPageOwnershipError(error))
                throw error;
        }
    }
    if (accessible.length === 0)
        return openChatGptPage(client, deadlineAt);
    if (accessible.length > 1)
        throw new Error("Multiple accessible ChatGPT tabs are open; set CDP_CHAT_BROWSERCLAW_PAGE to the one page id to own");
    return accessible[0].page;
}
async function openChatGptPage(client, deadlineAt) {
    const response = await client.callTool("tabs", { action: "new", url: `${CHATGPT_ORIGIN}/` }, deadlineAt);
    const page = parseOpenedPage(textContent(response));
    if (page === undefined)
        throw new Error("BrowserClaw did not report the page id of the new ChatGPT tab");
    while (Date.now() < deadlineAt) {
        const tab = (await listTabs(client, deadlineAt)).find((entry) => entry.page === page);
        if (tab && isChatGptUrl(tab.url)) {
            await assertAccessibleChatGptPage(client, page, deadlineAt);
            return page;
        }
        await client.callTool("wait", {
            page,
            for: "time",
            timeout: Math.min(1_000, remainingMs(deadlineAt)),
            value: 500,
        }, deadlineAt);
    }
    throw new Error("The newly created ChatGPT tab did not finish loading before the BrowserClaw deadline");
}
async function assertAccessibleChatGptPage(client, page, deadlineAt) {
    await client.callTool("snapshot", { page, mode: "interactive", depth: 1 }, deadlineAt);
}
function isPageOwnershipError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:not\s+owned|ownership|belongs\s+to\s+another|page\s+is\s+not\s+owned|another\s+agent)/iu.test(message);
}
function parseOpenedPage(value) {
    const match = value.match(/(?:opened page|page)\s+(\d+)/iu);
    const page = match ? Number(match[1]) : Number.NaN;
    return Number.isSafeInteger(page) && page >= 0 ? page : undefined;
}
async function listTabs(client, deadlineAt) {
    const response = await client.callTool("tabs", { action: "list" }, deadlineAt);
    const result = [];
    for (const match of textContent(response).matchAll(/^\s*\[(\d+)\]\s+(https?:\/\/\S+)/gmu)) {
        const page = Number(match[1]);
        if (Number.isSafeInteger(page) && page >= 0)
            result.push({ page, url: match[2] });
    }
    return result;
}
function isChatGptUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname === "chatgpt.com";
    }
    catch {
        return false;
    }
}
function parseJsonRpcBody(body) {
    const trimmed = body.trim();
    if (!trimmed)
        throw new Error("BrowserClaw MCP returned an empty response");
    try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed))
            return parsed;
    }
    catch {
        const events = trimmed.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
        for (let index = events.length - 1; index >= 0; index -= 1) {
            try {
                const parsed = JSON.parse(events[index]);
                if (isRecord(parsed))
                    return parsed;
            }
            catch {
                // Ignore keep-alive SSE events.
            }
        }
    }
    throw new Error("BrowserClaw MCP returned malformed JSON-RPC data");
}
function textContent(response) {
    const result = response.result;
    if (!isRecord(result) || !Array.isArray(result.content))
        return "";
    return result.content
        .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
}
function imageContent(response) {
    const result = response.result;
    if (!isRecord(result) || !Array.isArray(result.content))
        return undefined;
    return result.content.find((item) => isRecord(item)
        && item.type === "image"
        && typeof item.data === "string"
        && (item.mimeType === "image/png" || item.mimeType === "image/jpeg" || item.mimeType === "image/webp"));
}
function parseA11yNodes(snapshot) {
    const nodes = [];
    const pattern = /^\s*([A-Za-z][A-Za-z_-]*)(?:\s+"((?:\\.|[^"\\])*)")?[^\[]*\[ref=([^\]]+)\](?::\s*"((?:\\.|[^"\\])*)")?/gmu;
    for (const match of snapshot.matchAll(pattern)) {
        nodes.push({
            role: match[1].toLowerCase(),
            ref: match[3],
            ...(match[2] === undefined ? {} : { name: decodeQuoted(match[2]) }),
            ...(match[4] === undefined ? {} : { value: decodeQuoted(match[4]) }),
        });
    }
    return nodes;
}
function decodeQuoted(value) {
    try {
        return JSON.parse(`"${value}"`);
    }
    catch {
        return value;
    }
}
function findNode(nodes, predicate) {
    return nodes.find(predicate);
}
function findComposer(nodes) {
    const textboxes = nodes.filter((node) => node.role === "textbox");
    return textboxes.find((node) => COMPOSER_PATTERN.test(`${node.name ?? ""} ${node.value ?? ""}`)) ?? (textboxes.length === 1 ? textboxes[0] : undefined);
}
function findTaskControl(nodes, kind) {
    const candidates = nodes.filter((node) => ACTIONABLE_TASK_ROLES.has(node.role) && MODE_PATTERNS[kind].test(`${node.name ?? ""} ${node.value ?? ""}`));
    const menu = candidates.find((node) => node.role === "menuitemcheckbox" || node.role === "menuitem" || node.role === "option");
    return menu ?? candidates.find((node) => node.role === "button");
}
function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let end = Math.min(value.length, maxBytes);
    while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes)
        end -= 1;
    return value.slice(0, end);
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
