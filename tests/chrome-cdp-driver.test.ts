/**
 * Tests for the Chrome CDP driver.
 *
 * The driver is exercised against a scripted WebSocket server that speaks the
 * DevTools Protocol. No real Chrome is needed, and none is started here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import {
  CHROME_CDP_CHAT_CAPABILITIES,
  createChromeCdpCdpChatDriver,
  isChatGptUrl,
  conversationIdFromUrl,
} from "../src/chrome-cdp-driver.js";
import {
  commandUserDataDir,
  ownerMatchesProfile,
  parseDevToolsActivePort,
  type ChromeSocketOwner,
} from "../src/chrome-cdp-owner.js";

const CHAT_ID = "6ad7397c-3824-83ed-aa2c-103a12869fd5";
const OTHER_CHAT_ID = "6ab63437-c808-83eb-8b85-c3e3cc156a9f";

interface ScriptedChat {
  id: string;
  label: string;
}

interface ScriptedUnit {
  key: string;
  role: string;
  messageId: string;
  text: string;
}

interface ScriptedBrowser {
  targets: Array<{ targetId: string; type: string; url: string }>;
  chats: ScriptedChat[];
  units: ScriptedUnit[];
  url: string;
  hasComposer: boolean;
  buttonLabels: string[];
  composerText: string;
  sentTexts: string[];
  enterPresses: number;
  navigated: string[];
  closed: boolean;
  /** Model the page-native control: it rewrites the URL but keeps the conversation. */
  newChatKeepsConversation: boolean;
  /** How many pages the driver had to open itself. */
  createdTargets: number;
  /** Drop the first submit so the driver has to repeat it. */
  droppedSubmits: number;
}

const browsers: ScriptedBrowser[] = [];
const servers: WebSocketServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Start one scripted DevTools WebSocket server. */
async function startScriptedBrowser(overrides: Partial<ScriptedBrowser> = {}): Promise<{ url: string; browser: ScriptedBrowser }> {
  const browser: ScriptedBrowser = {
    targets: [{ targetId: "target-1", type: "page", url: `https://chatgpt.com/c/${CHAT_ID}` }],
    chats: [
      { id: OTHER_CHAT_ID, label: "План развития инженера" },
      { id: CHAT_ID, label: "ExManager Workspaace" },
    ],
    units: [
      { key: "turn-1:0:user", role: "user", messageId: "message-1", text: "первый вопрос" },
      { key: "turn-1:2:assistant", role: "assistant", messageId: "message-2", text: "первый ответ" },
    ],
    url: `https://chatgpt.com/c/${CHAT_ID}`,
    hasComposer: true,
    buttonLabels: ["Новый чат", "Отправить сообщение"],
    composerText: "",
    sentTexts: [],
    enterPresses: 0,
    navigated: [],
    closed: false,
    newChatKeepsConversation: false,
    createdTargets: 0,
    droppedSubmits: 0,
    ...overrides,
  };
  browsers.push(browser);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
      const result = respond(browser, message.method, message.params ?? {});
      socket.send(JSON.stringify({ id: message.id, result }));
    });
    socket.on("close", () => { browser.closed = true; });
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scripted server has no port");
  return { url: `ws://127.0.0.1:${address.port}/devtools/browser/scripted`, browser };
}

/** Answer one scripted CDP command. */
function respond(browser: ScriptedBrowser, method: string, params: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "Browser.getVersion":
      return { product: "Chrome/156.0.8078.48", protocolVersion: "1.3" };
    case "Target.getTargets":
      return { targetInfos: browser.targets };
    case "Target.attachToTarget":
      return { sessionId: "page-session-1" };
    case "Target.createTarget": {
      const targetId = `created-target-${browser.targets.length + 1}`;
      browser.targets.push({ targetId, type: "page", url: "https://chatgpt.com/" });
      browser.createdTargets += 1;
      return { targetId };
    }
    case "Page.navigate": {
      browser.navigated.push(String(params.url ?? ""));
      browser.url = String(params.url ?? browser.url);
      // A real navigation loads an empty conversation.
      if (browser.url === "https://chatgpt.com/") browser.units = [];
      return {};
    }
    case "Input.insertText":
      browser.composerText = String(params.text ?? "");
      browser.sentTexts.push(browser.composerText);
      return {};
    case "Input.dispatchKeyEvent":
      if (params.type === "keyDown") {
        browser.enterPresses += 1;
        browser.units = [
          ...browser.units,
          { key: `turn-${browser.units.length}:0:user`, role: "user", messageId: `message-${browser.units.length}`, text: browser.composerText },
        ];
        browser.composerText = "";
      }
      return {};
    case "Runtime.evaluate":
      return { result: { value: evaluate(browser, String(params.expression ?? "")) } };
    default:
      return {};
  }
}

/** Answer one scripted `Runtime.evaluate` expression. */
function evaluate(browser: ScriptedBrowser, expression: string): unknown {
  if (expression.includes("execCommand('delete')")) {
    browser.composerText = "";
    return { cleared: true, text: "" };
  }
  if (expression.includes("const button = [...document.querySelectorAll('button')]")) {
    if (browser.droppedSubmits > 0) {
      browser.droppedSubmits -= 1;
      browser.composerText = "";
      return { clicked: true };
    }
    browser.units = [
      ...browser.units,
      { key: `turn-${browser.units.length}:0:user`, role: "user", messageId: `message-${browser.units.length}`, text: browser.composerText },
    ];
    browser.composerText = "";
    browser.enterPresses += 1;
    return { clicked: true };
  }
  if (expression.includes("execCommand('delete')")) {
    browser.composerText = "";
    return { cleared: true, text: "" };
  }
  if (expression.includes("const button = [...document.querySelectorAll('button')]")) {
    if (browser.droppedSubmits > 0) {
      browser.droppedSubmits -= 1;
      browser.composerText = "";
      return { clicked: true };
    }
    browser.units = [
      ...browser.units,
      { key: `turn-${browser.units.length}:0:user`, role: "user", messageId: `message-${browser.units.length}`, text: browser.composerText },
    ];
    browser.composerText = "";
    browser.enterPresses += 1;
    return { clicked: true };
  }
  if (expression.includes("execCommand")) {
    const text = JSON.parse(expression.slice(expression.indexOf("(") + 1, expression.lastIndexOf(")"))) as string;
    browser.composerText = text;
    browser.sentTexts.push(text);
    return { inserted: true };
  }
  if (expression.includes("document.activeElement === composer")) return { focused: browser.hasComposer };
  if (expression.includes("composer.innerText || composer.value")) return { text: browser.composerText };
  if (expression.includes("Новый чат") || expression.includes("new chat")) {
    browser.url = "https://chatgpt.com/";
    if (!browser.newChatKeepsConversation) browser.units = [];
    return { clicked: true };
  }
  return {
    url: browser.url,
    chats: browser.chats,
    units: browser.units,
    hasComposer: browser.hasComposer,
    buttonLabels: browser.buttonLabels,
  };
}

/** Create a profile directory that holds a DevToolsActivePort file. */
async function createProfile(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chrome-cdp-profile-"));
  tempDirs.push(dir);
  if (content !== undefined) {
    await writeFile(join(dir, "DevToolsActivePort"), content, "utf-8");
  }
  return dir;
}

/** A socket owner that looks like the expected Chrome profile. */
function owner(profileDir: string): ChromeSocketOwner {
  return {
    pid: 4242,
    argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", `--user-data-dir=${profileDir}`],
    command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDir}`,
    socketIdentity: "inode:231",
  };
}

describe("chrome-cdp ownership proof", () => {
  it("parses the two-line DevToolsActivePort file", () => {
    const endpoint = parseDevToolsActivePort("9222\n/devtools/browser/b6025fd3-8972-4a79-af1a-85fc42beb027\n");
    expect(endpoint.port).toBe(9222);
    expect(endpoint.browserTargetPath).toBe("/devtools/browser/b6025fd3-8972-4a79-af1a-85fc42beb027");
  });

  it("rejects a malformed DevToolsActivePort file", () => {
    expect(() => parseDevToolsActivePort("9222\n")).toThrow(/malformed/);
    expect(() => parseDevToolsActivePort("notaport\n/devtools/browser/x\n")).toThrow(/invalid debugging port/);
    expect(() => parseDevToolsActivePort("9222\n/not-a-browser-path\n")).toThrow(/invalid browser target path/);
  });

  it("accepts a Chrome argv that names the expected profile", () => {
    expect(ownerMatchesProfile({ pid: 1, argv: ["/usr/bin/chrome", "--user-data-dir=/tmp/profile"], command: "/usr/bin/chrome --user-data-dir=/tmp/profile", socketIdentity: "inode:1" }, "/tmp/profile")).toEqual({ ok: true });
    expect(ownerMatchesProfile({ pid: 1, argv: ["/usr/bin/chrome"], command: "/usr/bin/chrome", socketIdentity: "inode:1" }, "/tmp/profile")).toEqual({ ok: true });
  });

  it("rejects a Chrome argv that owns another profile", () => {
    const result = ownerMatchesProfile({ pid: 1, argv: ["/usr/bin/chrome", "--user-data-dir=/tmp/other"], command: "/usr/bin/chrome --user-data-dir=/tmp/other", socketIdentity: "inode:1" }, "/tmp/profile");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("/tmp/other");
  });

  it("rejects a process that is not Chrome", () => {
    expect(ownerMatchesProfile({ pid: 1, argv: ["/usr/bin/python3"], command: "/usr/bin/python3 serve.py", socketIdentity: "inode:1" }, "/tmp/profile").ok).toBe(false);
  });

  it("matches a macOS command line whose profile path contains spaces", () => {
    const command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/user/Library/Application Support/Google/Chrome --profile-directory=Default";
    expect(commandUserDataDir(command)).toBe("/Users/user/Library/Application Support/Google/Chrome");
    expect(ownerMatchesProfile({ pid: 7, argv: [], command, socketIdentity: "lsof:127.0.0.1:9222" }, "/Users/user/Library/Application Support/Google/Chrome")).toEqual({ ok: true });
  });
});

describe("chrome-cdp driver", () => {
  it("declares only the operations it can execute", () => {
    expect(CHROME_CDP_CHAT_CAPABILITIES.new_chat).toBe(true);
    expect(CHROME_CDP_CHAT_CAPABILITIES.list_chats).toBe(true);
    expect(CHROME_CDP_CHAT_CAPABILITIES.export_chat).toBe(true);
    expect(CHROME_CDP_CHAT_CAPABILITIES.send_message).toBe(true);
    expect(CHROME_CDP_CHAT_CAPABILITIES.edit_message).toBe(false);
    expect(CHROME_CDP_CHAT_CAPABILITIES.research).toBe(false);
  });

  it("starts without Chrome and refuses with a concrete reason when the DevToolsActivePort file is missing", async () => {
    const profileDir = await createProfile();
    const driver = await createChromeCdpCdpChatDriver({ profileDir });
    await expect(driver.acquirePage()).rejects.toThrow(/DevToolsActivePort/);
  });

  it("refuses when nothing listens on the recorded port", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => null,
    });
    await expect(driver.acquirePage()).rejects.toThrow(/nothing is listening on the DevTools port 9222/);
  });

  it("refuses when the socket belongs to another Chrome profile", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => ({
        pid: 99,
        argv: ["/usr/bin/chrome", "--user-data-dir=/somewhere/else"],
        command: "/usr/bin/chrome --user-data-dir=/somewhere/else",
        socketIdentity: "inode:1",
      }),
    });
    await expect(driver.acquirePage()).rejects.toThrow(/instead of/);
  });

  it("lists the page-visible chats with their titles", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser();
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
    });
    const page = await driver.acquirePage();
    const snapshot = await page.snapshot();
    expect(snapshot.chats.map((chat) => chat.id)).toEqual([OTHER_CHAT_ID, CHAT_ID]);
    expect(snapshot.chats[0].title).toBe("План развития инженера");
    expect(snapshot.chats[1].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.chats[1].messages[0].text).toBe("первый вопрос");
  });

  it("sends one message into the chat it created", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser();
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
    });
    const page = await driver.acquirePage();
    const created = await page.createChat({ title: "Тестовый чат" });
    expect(created.id).toMatch(/^chrome-cdp-fixture:/);
    expect(scripted.browser.navigated).toEqual([]);

    const message = await page.sendMessage({ chatId: created.id, text: "привет из драйвера" });
    expect(message.role).toBe("user");
    expect(message.text).toBe("привет из драйвера");
    expect(scripted.browser.enterPresses).toBe(1);
    expect(scripted.browser.sentTexts).toContain("привет из драйвера");

    const snapshot = await page.snapshot();
    expect(snapshot.chats[0].id).toBe(created.id);
    expect(snapshot.chats[0].messages.some((entry) => entry.text.includes("привет из драйвера"))).toBe(true);
  });

  it("forces an empty conversation when the page-native control keeps the old one", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser({ newChatKeepsConversation: true });
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
      timeoutMs: 1500,
    });
    const page = await driver.acquirePage();
    const created = await page.createChat({ title: "Fresh chat" });
    expect(created.id).toMatch(/^chrome-cdp-fixture:/);
    // The click alone left the previous conversation rendered, so the driver
    // had to load a real empty conversation before sending anything.
    expect(scripted.browser.navigated).toEqual(["https://chatgpt.com/"]);
    expect(scripted.browser.units).toEqual([]);
  });

  it("repeats the send when the page does not submit the message", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser({ droppedSubmits: 1 });
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
      timeoutMs: 20000,
    });
    const page = await driver.acquirePage();
    const created = await page.createChat({ title: "Retry chat" });
    const message = await page.sendMessage({ chatId: created.id, text: "повтор отправки" });
    expect(message.role).toBe("user");
    expect(message.text).toBe("повтор отправки");
    expect(scripted.browser.units.some((unit) => unit.text.includes("повтор отправки"))).toBe(true);
  });

  it("opens exactly one ChatGPT page when none is open", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser({ targets: [{ targetId: "t", type: "page", url: "https://example.com/" }] });
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
    });
    const page = await driver.acquirePage();
    expect(scripted.browser.createdTargets).toBe(1);
    const snapshot = await page.snapshot();
    expect(snapshot.chats.length).toBeGreaterThan(0);
  });

  it("refuses when the requested page target is not open", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser();
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
      targetId: "missing-target",
    });
    await expect(driver.acquirePage()).rejects.toThrow(/requested ChatGPT page missing-target is not open/);
  });

  it("refuses when several ChatGPT pages are open", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser({
      targets: [
        { targetId: "t1", type: "page", url: "https://chatgpt.com/c/one" },
        { targetId: "t2", type: "page", url: "https://chatgpt.com/c/two" },
      ],
    });
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
    });
    await expect(driver.acquirePage()).rejects.toThrow(/2 ChatGPT pages are open/);
  });

  it("detects that Chrome restarted and the proven endpoint changed", async () => {
    const profileDir = await createProfile("9222\n/devtools/browser/abc\n");
    const scripted = await startScriptedBrowser();
    const driver = await createChromeCdpCdpChatDriver({
      profileDir,
      ownershipProbe: async () => owner(profileDir),
      browserWsUrl: scripted.url,
    });
    await driver.acquirePage();
    await writeFile(join(profileDir, "DevToolsActivePort"), "9223\n/devtools/browser/def\n", "utf-8");
    await expect(driver.acquirePage()).rejects.toThrow(/Chrome was restarted/);
  });

  it("recognizes ChatGPT urls and conversation ids", () => {
    expect(isChatGptUrl("https://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptUrl("https://example.com/c/abc")).toBe(false);
    expect(conversationIdFromUrl("https://chatgpt.com/c/6ad7397c-3824-83ed-aa2c-103a12869fd5")).toBe(CHAT_ID);
    expect(conversationIdFromUrl("https://chatgpt.com/")).toBeUndefined();
  });
});
