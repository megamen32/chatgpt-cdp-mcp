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
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { defaultChromeProfileDir, proveChromeOwnership, readDevToolsEndpoint, } from "./chrome-cdp-owner.js";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_HOST = "chatgpt.com";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 400;
const MAX_RESULT_BYTES = 64 * 1024;
/** A capability set truthful for the Chrome CDP page driver. */
export const CHROME_CDP_CHAT_CAPABILITIES = {
    new_chat: true,
    list_chats: true,
    search_chat: true,
    export_chat: true,
    send_message: true,
    edit_message: false,
    download_media: false,
    research: false,
    search: false,
    draw: false,
};
/** Open a WebSocket to a DevTools endpoint with the standard `ws` client. */
export const defaultWebSocketFactory = (url) => {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    return {
        send: (data) => socket.send(data),
        close: () => socket.close(),
        onOpen: (listener) => socket.on("open", () => listener()),
        onMessage: (listener) => socket.on("message", (data) => listener(String(data))),
        onClose: (listener) => socket.on("close", () => listener()),
        onError: (listener) => socket.on("error", (error) => listener(error)),
    };
};
/** A refusal raised by the Chrome CDP driver. */
export class ChromeCdpError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = "ChromeCdpError";
    }
}
/**
 * Resolve the one real composer.
 *
 * ChatGPT keeps more than one `contenteditable` element in the DOM: a hidden
 * stale editor sits in front of the live one, so the first match is the wrong
 * element. The focused element wins, otherwise the last visible one.
 */
const COMPOSER_RESOLVER = `(() => {
  const candidates = [...document.querySelectorAll('div[contenteditable="true"], textarea')];
  if (candidates.length === 0) return undefined;
  const active = document.activeElement;
  if (active && candidates.includes(active)) return active;
  const visible = candidates.filter((c) => {
    const rect = c.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(c).visibility !== 'hidden';
  });
  return visible[visible.length - 1] ?? candidates[candidates.length - 1];
})()`;
/** Read the sidebar, the rendered conversation and the composer state. */
const READ_PAGE_STATE = `(() => {
  const chats = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href^="/c/"]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const id = href.replace(/^\\/c\\//, '').split('?')[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chats.push({ id, label: a.getAttribute('aria-label') || '', text: (a.innerText || '').trim() });
  }
  const units = [];
  for (const u of document.querySelectorAll('[data-chatgpt-search-unit-key]')) {
    const key = u.getAttribute('data-chatgpt-search-unit-key') || '';
    const roleNode = u.querySelector('[data-conversation-role]');
    const body = u.querySelector('[data-chatgpt-selection-message-id]');
    let role = roleNode ? (roleNode.getAttribute('data-conversation-role') || '') : '';
    if (!role) role = /:user$/u.test(key) ? 'user' : (/:assistant$/u.test(key) ? 'assistant' : '');
    units.push({
      key,
      role,
      messageId: body ? (body.getAttribute('data-chatgpt-selection-message-id') || '') : '',
      text: ((body ? body.innerText : u.innerText) || '').trim(),
    });
  }
  const buttons = [];
  for (const b of document.querySelectorAll('button')) {
    const label = (b.getAttribute('aria-label') || b.innerText || '').replace(/\\s+/gu, ' ').trim();
    if (label) buttons.push(label);
  }
  return {
    url: location.href,
    chats,
    units,
    hasComposer: !!(${COMPOSER_RESOLVER}),
    buttonLabels: buttons.slice(0, 80),
  };
})()`;
/** Focus the ChatGPT composer and place the caret inside it. */
const FOCUS_COMPOSER = `(() => {
  const composer = ${COMPOSER_RESOLVER};
  if (!composer) return { focused: false };
  composer.focus();
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch (error) {
    // A caret is a convenience here; the text insertion below is the contract.
  }
  return { focused: document.activeElement === composer };
})()`;
/** Read the current text of the composer. */
const READ_COMPOSER = `(() => {
  const composer = ${COMPOSER_RESOLVER};
  if (!composer) return { text: '' };
  return { text: (composer.innerText || composer.value || '') };
})()`;
/** Remove any text the page restored into the composer. */
const CLEAR_COMPOSER = `(() => {
  const composer = ${COMPOSER_RESOLVER};
  if (!composer) return { cleared: false };
  composer.focus();
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('delete');
  } catch (error) {
    return { cleared: false };
  }
  return { cleared: true, text: (composer.innerText || composer.value || '') };
})()`;
/** Click the page-native send control. */
const CLICK_SEND = `(() => {
  const normalize = (value) => (value || '').replace(/\s+/gu, ' ').trim();
  const button = [...document.querySelectorAll('button')].find((b) => {
    const label = normalize(b.getAttribute('aria-label')) || normalize(b.innerText);
    return /^(send|send message|отправить|отправить сообщение)$/iu.test(label);
  });
  if (!button) return { clicked: false };
  button.click();
  return { clicked: true };
})()`;
/** Build the expression that inserts text into the composer as one edit. */
function insertTextExpression(text) {
    return `(() => {
  const text = ${JSON.stringify(text)};
  const composer = ${COMPOSER_RESOLVER};
  if (!composer) return { inserted: false };
  composer.focus();
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch (error) {
    inserted = false;
  }
  const current = composer.innerText || composer.value || '';
  return { inserted: inserted || current.indexOf(text) !== -1 };
})()`;
}
/** Click the page-native "New chat" control. */
const CLICK_NEW_CHAT = `(() => {
  const normalize = (value) => (value || '').replace(/\\s+/gu, ' ').trim();
  const buttons = [...document.querySelectorAll('button, a')];
  const target = buttons.find((b) => {
    const label = normalize(b.getAttribute('aria-label')) || normalize(b.innerText);
    return /^(new chat|новый чат)$/iu.test(label);
  });
  if (!target) return { clicked: false, labels: buttons.map((b) => normalize(b.getAttribute('aria-label')) || normalize(b.innerText)).filter(Boolean).slice(0, 40) };
  target.click();
  return { clicked: true };
})()`;
/** Thin CDP client over one browser WebSocket. */
class CdpConnection {
    factory;
    socket;
    nextId = 1;
    pending = new Map();
    closed = false;
    constructor(factory) {
        this.factory = factory;
    }
    async connect(url, timeoutMs) {
        let socket;
        try {
            socket = this.factory(url);
        }
        catch (error) {
            throw new ChromeCdpError("chrome_cdp_ws_failed", `Chrome access unavailable: ${error.message}`);
        }
        this.socket = socket;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new ChromeCdpError("chrome_cdp_ws_timeout", `Chrome access unavailable: the browser WebSocket ${url} did not open within ${timeoutMs}ms.`));
            }, timeoutMs);
            let settled = false;
            const succeed = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            };
            socket.onOpen(succeed);
            socket.onError((error) => fail(new ChromeCdpError("chrome_cdp_ws_failed", `Chrome access unavailable: ${error.message}`)));
            socket.onClose(() => fail(new ChromeCdpError("chrome_cdp_ws_closed", `Chrome access unavailable: the browser WebSocket ${url} closed during the handshake.`)));
            socket.onMessage((data) => this.dispatch(data));
        });
    }
    dispatch(data) {
        let message;
        try {
            message = JSON.parse(data);
        }
        catch {
            return;
        }
        if (typeof message.id !== "number")
            return;
        const request = this.pending.get(message.id);
        if (!request)
            return;
        this.pending.delete(message.id);
        if (message.error) {
            request.reject(new ChromeCdpError("chrome_cdp_command_failed", message.error.message ?? `CDP command ${message.id} failed.`));
            return;
        }
        request.resolve(message.result ?? {});
    }
    async send(method, params = {}, sessionId) {
        if (this.closed || !this.socket) {
            throw new ChromeCdpError("chrome_cdp_ws_closed", "Chrome access unavailable: the browser WebSocket is closed.");
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            }
            catch (error) {
                this.pending.delete(id);
                reject(new ChromeCdpError("chrome_cdp_command_failed", `CDP command ${method} could not be sent: ${error.message}`));
            }
        });
    }
    close() {
        this.closed = true;
        try {
            this.socket?.close();
        }
        catch {
            // A closed socket is already the desired state.
        }
    }
}
/** One attached ChatGPT page. */
class ChromeCdpSession {
    proof;
    explicitWsUrl;
    options;
    connection;
    sessionId;
    page;
    constructor(proof, explicitWsUrl, options) {
        this.proof = proof;
        this.explicitWsUrl = explicitWsUrl;
        this.options = options;
        this.connection = new CdpConnection(options.webSocketFactory);
    }
    /** Open the browser WebSocket and attach to the one ChatGPT page. */
    async open() {
        const url = this.browserWsUrl();
        await this.connection.connect(url, this.options.timeoutMs);
        const version = await this.connection.send("Browser.getVersion");
        if (!version.product) {
            throw new ChromeCdpError("chrome_cdp_browser_unidentified", "Chrome access unavailable: the browser WebSocket did not identify a Chrome browser.");
        }
        const { targetInfos } = await this.connection.send("Target.getTargets");
        const pages = targetInfos ?? [];
        const chatgpt = pages.filter((target) => target.type === "page" && isChatGptUrl(target.url));
        const wanted = this.options.targetId?.trim();
        let target;
        if (wanted) {
            target = chatgpt.find((entry) => entry.targetId === wanted);
            if (!target) {
                throw new ChromeCdpError("chrome_cdp_target_not_found", `Chrome access unavailable: the requested ChatGPT page ${wanted} is not open in this Chrome.`);
            }
        }
        else {
            if (chatgpt.length === 0) {
                throw new ChromeCdpError("chrome_cdp_no_chatgpt_page", "Chrome access unavailable: no open ChatGPT page was found in this Chrome. Open https://chatgpt.com/ in the browser and try again.");
            }
            if (chatgpt.length > 1) {
                throw new ChromeCdpError("chrome_cdp_ambiguous_chatgpt_page", `Chrome access unavailable: ${chatgpt.length} ChatGPT pages are open; close the extra ones or set CDP_CHAT_CHROME_TARGET_ID to the one page this driver owns.`);
            }
            target = chatgpt[0];
        }
        const attached = await this.connection.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        const sessionId = attached.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new ChromeCdpError("chrome_cdp_attach_failed", "Chrome access unavailable: attaching to the ChatGPT page did not return a page session.");
        }
        this.sessionId = sessionId;
        this.page = { targetId: target.targetId, url: target.url };
    }
    /** The browser WebSocket URL proven by the ownership check. */
    browserWsUrl() {
        if (this.explicitWsUrl)
            return this.explicitWsUrl;
        if (this.proof) {
            return `ws://127.0.0.1:${this.proof.endpoint.port}${this.proof.endpoint.browserTargetPath}`;
        }
        throw new ChromeCdpError("chrome_cdp_endpoint_missing", "Chrome access unavailable: no browser WebSocket endpoint was proven.");
    }
    /** Re-check that the proven endpoint is still the live Chrome endpoint. */
    async assertLease() {
        if (!this.proof)
            return;
        const current = await readDevToolsEndpoint(this.proof.profileDir);
        if (current.port !== this.proof.endpoint.port || current.browserTargetPath !== this.proof.endpoint.browserTargetPath) {
            throw new ChromeCdpError("chrome_cdp_lease_lost", `Chrome access unavailable: the DevTools endpoint in ${this.proof.profileDir} changed; Chrome was restarted or the remote debugging toggle was turned off.`);
        }
    }
    /** The attached page facts. */
    attached() {
        if (!this.page) {
            throw new ChromeCdpError("chrome_cdp_not_attached", "Chrome access unavailable: the ChatGPT page is not attached.");
        }
        return this.page;
    }
    /** Evaluate one expression in the attached page and return its value. */
    async evaluate(expression) {
        const response = await this.connection.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
        }, this.sessionId);
        const exception = response.exceptionDetails;
        if (exception) {
            throw new ChromeCdpError("chrome_cdp_evaluate_failed", exception.exception?.description ?? exception.text ?? "The ChatGPT page rejected a DOM read.");
        }
        const result = response.result;
        return result?.value;
    }
    /** Type one message into the composer and press Enter. */
    async submitPrompt(text) {
        const focused = await this.evaluate(FOCUS_COMPOSER);
        if (!focused?.focused) {
            throw new ChromeCdpError("chrome_cdp_composer_missing", "The ChatGPT composer was not found on the owned page.");
        }
        // ChatGPT restores the composer draft after a reload, so the composer is
        // emptied first: a stale draft must never ride along with the message.
        await this.evaluate(CLEAR_COMPOSER);
        await this.connection.send("Input.insertText", { text }, this.sessionId);
        let composer = await this.evaluate(READ_COMPOSER);
        if (!composer?.text?.includes(text.trim().slice(0, 40))) {
            const fallback = await this.evaluate(insertTextExpression(text));
            if (!fallback?.inserted) {
                throw new ChromeCdpError("chrome_cdp_composer_input_failed", "The ChatGPT composer did not accept the message text.");
            }
            composer = await this.evaluate(READ_COMPOSER);
        }
        if (!composer?.text?.includes(text.trim().slice(0, 40))) {
            throw new ChromeCdpError("chrome_cdp_composer_input_failed", "The ChatGPT composer did not accept the message text.");
        }
        // The page-native send control is the reliable submit path; the Enter key
        // stays as the fallback for a composer without one.
        const sent = await this.evaluate(CLICK_SEND);
        if (!sent?.clicked) {
            const enter = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r" };
            await this.connection.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter }, this.sessionId);
            await this.connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter }, this.sessionId);
        }
    }
    /** Navigate the owned page to one URL. */
    async navigate(url) {
        await this.connection.send("Page.navigate", { url }, this.sessionId);
    }
    /** Close the browser WebSocket. */
    close() {
        this.connection.close();
    }
}
/** Decide whether one URL belongs to ChatGPT. */
export function isChatGptUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname === CHATGPT_HOST;
    }
    catch {
        return false;
    }
}
/** Extract the conversation id from a ChatGPT conversation URL. */
export function conversationIdFromUrl(value) {
    return /\/c\/([A-Za-z0-9-]+)/u.exec(value)?.[1];
}
/** Normalize one sidebar entry into a bounded chat record. */
function toChatRecord(entry, index, now) {
    const title = entry.label.trim() || entry.text.trim() || "ChatGPT";
    return {
        id: entry.id,
        title: truncateUtf8(title, 512),
        unread: false,
        working: false,
        // The current ChatGPT sidebar exposes no per-chat timestamp. The sidebar
        // order is the page's own recency order, so the timestamp is derived from
        // that order instead of being invented per chat.
        updatedAt: new Date(now - index * 60_000).toISOString(),
        messages: [],
    };
}
/** Normalize one conversation unit into a bounded message record. */
function toMessageRecord(unit, index, now) {
    const role = unit.role === "user" ? "user" : unit.role === "assistant" ? "assistant" : undefined;
    if (!role)
        return undefined;
    const text = unit.text.trim();
    if (!text)
        return undefined;
    return {
        id: unit.messageId || `${unit.key || "turn"}:${index}`,
        role,
        text: truncateUtf8(text, MAX_RESULT_BYTES),
        version: 1,
        createdAt: new Date(now + index).toISOString(),
        media: [],
    };
}
/** Truncate a string to a UTF-8 byte limit. */
function truncateUtf8(value, maxBytes) {
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let end = Math.min(value.length, maxBytes);
    while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes)
        end -= 1;
    return value.slice(0, end);
}
/** Wait for one condition, polling the page. */
async function waitFor(probe, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            const value = await probe();
            if (value !== undefined)
                return value;
        }
        catch (error) {
            last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
    }
    throw new ChromeCdpError("chrome_cdp_timeout", `ChatGPT ${description} did not happen before the ${timeoutMs}ms deadline${last instanceof Error ? `: ${last.message}` : "."}`);
}
/** The one ChatGPT page owned by this driver. */
class ChromeCdpPage {
    sessionProvider;
    timeoutMs;
    fixture;
    identityValue;
    constructor(sessionProvider, timeoutMs) {
        this.sessionProvider = sessionProvider;
        this.timeoutMs = timeoutMs;
    }
    async identity() {
        if (!this.identityValue) {
            const attached = this.sessionProvider().attached();
            const digest = createHash("sha256").update(`chrome-cdp:${attached.targetId}`).digest("hex").slice(0, 24);
            this.identityValue = {
                origin: CHATGPT_ORIGIN,
                accountRef: `chrome-cdp:${digest}`,
                pageRef: `chrome-cdp-page:${digest}`,
                leaseRef: `chrome-cdp-lease:${digest}`,
            };
        }
        return this.identityValue;
    }
    async snapshot() {
        const state = await this.readState();
        const now = Date.now();
        const openId = conversationIdFromUrl(state.url);
        const chats = state.chats.map((entry, index) => toChatRecord(entry, index, now));
        const messages = state.units
            .map((unit, index) => toMessageRecord(unit, index, now))
            .filter((entry) => entry !== undefined);
        const open = openId ? chats.find((chat) => chat.id === openId) : undefined;
        if (open) {
            open.messages = messages;
            open.working = isGenerating(state.buttonLabels);
        }
        if (this.fixture && !chats.some((chat) => chat.id === this.fixture.id)) {
            chats.unshift({
                id: this.fixture.id,
                title: this.fixture.title,
                unread: false,
                working: open?.working ?? false,
                updatedAt: this.fixture.updatedAt,
                messages: openId === this.fixture.chatId ? messages : [],
            });
        }
        return { chats };
    }
    async createChat(input) {
        const freshConversation = async () => {
            const state = await this.readState();
            if (!state.hasComposer)
                return undefined;
            // A fresh conversation has no /c/ id and no rendered message. The
            // page-native "New chat" control only rewrites the URL and leaves the
            // previous conversation rendered, so the rendered messages decide.
            if (conversationIdFromUrl(state.url))
                return undefined;
            if (state.units.length > 0)
                return undefined;
            return state;
        };
        const clicked = await this.sessionProvider().evaluate(CLICK_NEW_CHAT);
        if (clicked.clicked) {
            // The page-native control switches immediately or not at all, so a short
            // wait is enough before falling back to a real navigation.
            await waitFor(freshConversation, Math.min(this.timeoutMs, 2_500), "new chat").catch(() => undefined);
        }
        if (!clicked.clicked || !(await freshConversation())) {
            // Only a real navigation guarantees an empty conversation.
            await this.ensureFreshConversation();
        }
        await waitFor(freshConversation, this.timeoutMs, "new chat");
        const createdAt = new Date().toISOString();
        this.fixture = {
            id: `chrome-cdp-fixture:${randomUUID()}`,
            title: input.title?.trim() || "ChatGPT CDP MCP disposable chat",
            createdAt,
            updatedAt: createdAt,
        };
        return {
            id: this.fixture.id,
            title: this.fixture.title,
            unread: false,
            working: false,
            updatedAt: createdAt,
            messages: [],
        };
    }
    async sendMessage(input) {
        await this.openChatForSending(input.chatId);
        const state = await this.readState();
        if (!state.hasComposer) {
            throw new ChromeCdpError("chrome_cdp_composer_missing", "The ChatGPT composer was not found on the owned page.");
        }
        // The page restores its own composer draft and can overwrite the text
        // between the insertion and the submit, so the send is verified and
        // repeated until the message really appears.
        const marker = input.text.trim().slice(0, 40);
        let sent;
        for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
            await this.sessionProvider().submitPrompt(input.text);
            sent = await waitFor(async () => {
                const units = await this.readUnits();
                return [...units].reverse().find((entry) => entry.role === "user" && entry.text.includes(marker));
            }, 4_000, "message").catch(() => undefined);
        }
        if (!sent) {
            throw new ChromeCdpError("chrome_cdp_submit_failed", "The ChatGPT composer did not submit the message.");
        }
        const message = {
            id: sent.messageId || `chrome-cdp-user:${randomUUID()}`,
            role: "user",
            text: input.text,
            version: 1,
            createdAt: new Date().toISOString(),
            media: [],
        };
        const openId = conversationIdFromUrl((await this.readState()).url);
        if (this.fixture && openId) {
            this.fixture.chatId = openId;
            this.fixture.updatedAt = message.createdAt;
        }
        return message;
    }
    async editMessage() {
        throw new ChromeCdpError("chrome_cdp_edit_unsupported", "The Chrome CDP driver does not implement edit_message.");
    }
    async downloadMedia() {
        throw new ChromeCdpError("chrome_cdp_download_unsupported", "The Chrome CDP driver does not implement download_media.");
    }
    /** Make the target chat the one shown by the owned page. */
    async openChatForSending(chatId) {
        const current = await this.readState();
        const currentId = conversationIdFromUrl(current.url);
        if (this.fixture && chatId === this.fixture.id) {
            const wanted = this.fixture.chatId;
            if (wanted && currentId === wanted)
                return;
            if (wanted) {
                await this.sessionProvider().navigate(`${CHATGPT_ORIGIN}/c/${wanted}`);
            }
            else if (currentId) {
                // The disposable chat has no conversation id yet, so the page must go
                // back to an empty conversation instead of the one it still shows.
                await this.ensureFreshConversation();
            }
        }
        else if (currentId !== chatId) {
            await this.sessionProvider().navigate(`${CHATGPT_ORIGIN}/c/${chatId}`);
        }
        await waitFor(async () => {
            const state = await this.readState();
            if (!state.hasComposer)
                return undefined;
            const wanted = this.fixture && chatId === this.fixture.id ? this.fixture.chatId : chatId;
            if (wanted && conversationIdFromUrl(state.url) !== wanted)
                return undefined;
            return state;
        }, this.timeoutMs, "chat");
    }
    /** Load an empty conversation and wait until it is really empty. */
    async ensureFreshConversation() {
        await this.sessionProvider().navigate(`${CHATGPT_ORIGIN}/`);
        await waitFor(async () => {
            const state = await this.readState();
            if (!state.hasComposer)
                return undefined;
            if (state.units.length > 0)
                return undefined;
            if (conversationIdFromUrl(state.url))
                return undefined;
            return state;
        }, this.timeoutMs, "new chat");
    }
    async readUnits() {
        const raw = await this.sessionProvider().evaluate(READ_PAGE_STATE);
        return Array.isArray(raw?.units) ? raw.units : [];
    }
    async readState() {
        const raw = await this.sessionProvider().evaluate(READ_PAGE_STATE);
        return {
            url: typeof raw?.url === "string" ? raw.url : "",
            chats: Array.isArray(raw?.chats) ? raw.chats : [],
            units: Array.isArray(raw?.units) ? raw.units : [],
            hasComposer: raw?.hasComposer === true,
            buttonLabels: Array.isArray(raw?.buttonLabels) ? raw.buttonLabels : [],
        };
    }
}
/** Decide whether the page shows a running generation. */
function isGenerating(buttonLabels) {
    return buttonLabels.some((label) => /(stop generating|stop response|остановить|прерват)/iu.test(label));
}
/**
 * Create the Chrome CDP driver.
 *
 * The driver connects lazily: the MCP server starts even when Chrome is not
 * running, and every operation then refuses with the concrete reason.
 */
export async function createChromeCdpCdpChatDriver(options = {}) {
    const configuredTimeout = Number.parseInt(process.env.CDP_CHAT_CHROME_TIMEOUT_MS ?? "", 10);
    const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1000) {
        throw new Error("CDP_CHAT_CHROME_TIMEOUT_MS must be an integer from 1000 to 3600000");
    }
    const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    const profileDir = options.profileDir ?? process.env.CDP_CHAT_CHROME_PROFILE_DIR?.trim() ?? defaultChromeProfileDir();
    const explicitWsUrl = options.browserWsUrl ?? process.env.CDP_CHAT_CHROME_BROWSER_WS_URL?.trim() ?? undefined;
    const targetId = options.targetId ?? process.env.CDP_CHAT_CHROME_TARGET_ID?.trim() ?? undefined;
    let session;
    const openSession = async () => {
        if (!session) {
            let proof;
            if (explicitWsUrl) {
                if (options.requireOwnership !== false) {
                    proof = await proveChromeOwnership({ profileDir, probe: options.ownershipProbe });
                }
            }
            else {
                proof = await proveChromeOwnership({ profileDir, probe: options.ownershipProbe });
            }
            session = new ChromeCdpSession(proof, explicitWsUrl, { timeoutMs, webSocketFactory, targetId });
            await session.open();
        }
        else {
            await session.assertLease();
        }
        return session;
    };
    const page = new ChromeCdpPage(() => {
        if (!session)
            throw new ChromeCdpError("chrome_cdp_not_attached", "Chrome access unavailable: the ChatGPT page is not attached.");
        return session;
    }, timeoutMs);
    return {
        capabilities: CHROME_CDP_CHAT_CAPABILITIES,
        async acquirePage() {
            await openSession();
            return page;
        },
        /** Close the browser WebSocket held by this driver. */
        close() {
            session?.close();
        },
    };
}
