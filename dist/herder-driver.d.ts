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
import { type ChromeCdpDriverOptions } from "./chrome-cdp-driver.js";
import type { CdpChatDriver } from "./cdp-chat.js";
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
    sendMessage(input: {
        chatId: string;
        text: string;
        waitForCompletion?: boolean;
    }): Promise<{
        assistantText?: string;
    }>;
    createChat(input: {
        title?: string;
    }): Promise<HerderChat>;
    listModels(): Promise<string[]>;
    changeModel(input: {
        chatId: string;
        model: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
}
/**
 * Create the Agent Herder driver.
 *
 * The factory takes no arguments: Agent Herder calls it bare, so the
 * connection is configured through the environment.
 */
export declare function createCdpChatDriver(options?: ChromeCdpDriverOptions): Promise<CdpChatDriver & {
    agentHarnessDriver: HerderHarnessDriver;
}>;
export default createCdpChatDriver;
