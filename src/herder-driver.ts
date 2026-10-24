/**
 * Agent Herder adapter for the Chrome CDP driver.
 *
 * Agent Herder loads this module through `CDP_CHAT_DRIVER_MODULE` and calls
 * `createCdpChatDriver()`. The returned driver exposes the normal page seam
 * plus an `agentHarnessDriver`, which turns ChatGPT chats into Agent Herder
 * sessions: they are listed, they can be created, messaged, and their model
 * can be switched through the page's own controls.
 *
 * Nothing here adds a second browser lease: the adapter shares the one owned
 * ChatGPT page of the driver.
 */

import { createChromeCdpCdpChatDriver, type ChromeCdpDriverOptions } from "./chrome-cdp-driver.js";
import type { CdpChatDriver, CdpChatPage } from "./cdp-chat.js";

/** One ChatGPT chat as an Agent Herder session. */
export interface HerderChat {
  id: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
  sourceRoute?: string;
  updatedAtSemantics?: string;
}

/** The session-facing surface Agent Herder drives. */
export interface HerderHarnessDriver {
  listChats(signal?: AbortSignal): Promise<readonly HerderChat[]>;
  sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }>;
  createChat(input: { title?: string }): Promise<HerderChat>;
  listModels(): Promise<string[]>;
  changeModel(input: { chatId: string; model: string }): Promise<{ ok: boolean; error?: string }>;
}

/** Page methods the Chrome CDP driver adds on top of the shared contract. */
interface ChromeCdpPageExtras {
  listModels?(): Promise<string[]>;
  changeModel?(chatId: string, model: string): Promise<{ ok: boolean; error?: string }>;
}

/** Turn the page seam into the Agent Herder session seam. */
class ChromeCdpHarnessDriver implements HerderHarnessDriver {
  constructor(private readonly driver: CdpChatDriver) {}

  async listChats(): Promise<readonly HerderChat[]> {
    const page = await this.driver.acquirePage();
    const snapshot = await page.snapshot();
    return snapshot.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      unread: chat.unread,
      working: chat.working,
      updatedAt: chat.updatedAt,
      sourceRoute: chat.id.startsWith("chrome-cdp-fixture:") ? undefined : `https://chatgpt.com/c/${chat.id}`,
      updatedAtSemantics: "sidebar-order-derived",
    }));
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    const page = await this.driver.acquirePage();
    await page.sendMessage({ chatId: input.chatId, text: input.text });
    if (input.waitForCompletion === false) return {};
    const snapshot = await page.snapshot();
    const chat = snapshot.chats.find((entry) => entry.id === input.chatId);
    const assistant = chat?.messages.filter((message) => message.role === "assistant").at(-1);
    return assistant ? { assistantText: assistant.text } : {};
  }

  async createChat(input: { title?: string }): Promise<HerderChat> {
    const page = await this.driver.acquirePage();
    const record = await page.createChat({ title: input.title });
    return {
      id: record.id,
      title: record.title,
      unread: false,
      working: false,
      updatedAt: record.updatedAt,
    };
  }

  async listModels(): Promise<string[]> {
    const page = await this.driver.acquirePage() as CdpChatPage & ChromeCdpPageExtras;
    if (typeof page.listModels !== "function") return [];
    return page.listModels();
  }

  async changeModel(input: { chatId: string; model: string }): Promise<{ ok: boolean; error?: string }> {
    const page = await this.driver.acquirePage() as CdpChatPage & ChromeCdpPageExtras;
    if (typeof page.changeModel !== "function") {
      return { ok: false, error: "The Chrome CDP driver does not expose a model picker." };
    }
    return page.changeModel(input.chatId, input.model);
  }
}

/**
 * Create the Agent Herder driver.
 *
 * The factory takes no arguments: Agent Herder calls it bare, so the
 * connection is configured through the environment.
 */
export async function createCdpChatDriver(options: ChromeCdpDriverOptions = {}): Promise<CdpChatDriver & { agentHarnessDriver: HerderHarnessDriver }> {
  const driver = await createChromeCdpCdpChatDriver(options);
  return { ...driver, agentHarnessDriver: new ChromeCdpHarnessDriver(driver) };
}

export default createCdpChatDriver;
