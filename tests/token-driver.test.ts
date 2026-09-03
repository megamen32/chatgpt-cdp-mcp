/** Tests for the read-only session-cookie token driver. */

import { describe, expect, it } from "vitest";

import { createTokenCdpChatDriver } from "../src/token-driver.js";
import type { TokenDriverOptions } from "../src/token-driver.js";

const SESSION_TOKEN = "st-test-cookie";
const ACCESS_TOKEN = "eyJ.a.token";

type Route = { match: string; status: number; body: unknown };

function makeFetch(routes: Route[]) {
  return (async (url: URL | string) => {
    const target = String(url);
    const route = routes.find(({ match }) => target.includes(match));
    if (!route) throw new Error(`no route for ${target}`);
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
}

function scriptRoutes(): Route[] {
  return [
    { match: "/api/auth/session", status: 200, body: { accessToken: ACCESS_TOKEN, expires: "2026-12-02" } },
    {
      match: "/backend-api/conversations",
      status: 200,
      body: { items: [
        { id: "chat-1", title: "Что такое SFU", update_time: 1_788_400_000 },
        { id: "chat-2", title: "Старее", update_time: 1_788_300_000 },
      ] },
    },
    {
      match: "/backend-api/conversation/chat-1",
      status: 200,
      body: { title: "Что такое SFU", mapping: {
        a: { message: { author: { role: "system" }, content: { parts: ["hidden"] }, create_time: 1 } },
        b: { message: { author: { role: "user" }, content: { parts: ["вопрос"] }, create_time: 2 } },
        c: { message: { author: { role: "assistant" }, content: { parts: ["ответ"] }, create_time: 3 } },
      } },
    },
    {
      match: "/backend-api/conversation/chat-2",
      status: 200,
      body: { title: "Старее", mapping: {
        d: { message: { author: { role: "user" }, content: { parts: ["старый вопрос"] }, create_time: 5 } },
      } },
    },
  ];
}

function driverOptions(): TokenDriverOptions {
  return {
    sessionToken: SESSION_TOKEN,
    fetchImpl: makeFetch(scriptRoutes()),
  };
}

describe("token driver", () => {
  it("declares read-only capabilities", async () => {
    const driver = await createTokenCdpChatDriver(driverOptions());
    expect(driver.capabilities?.list_chats).toBe(true);
    expect(driver.capabilities?.export_chat).toBe(true);
    expect(driver.capabilities?.send_message).toBe(false);
    expect(driver.capabilities?.new_chat).toBe(false);
    expect(driver.capabilities?.draw).toBe(false);
  });

  it("builds a snapshot with ordered messages from backend-api", async () => {
    const driver = await createTokenCdpChatDriver(driverOptions());
    const page = await driver.acquirePage();
    const snapshot = await page.snapshot();
    expect(snapshot.chats.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"]);
    const first = snapshot.chats[0];
    expect(first.title).toBe("Что такое SFU");
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(first.messages[0].text).toBe("вопрос");
    expect(first.messages[0].media).toEqual([]);
  });

  it("sends the session cookie to the token exchange endpoint", async () => {
    const cookies: string[] = [];
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const target = String(url);
      const route = scriptRoutes().find(({ match }) => target.includes(match))!;
      if (target.includes("/api/auth/session")) {
        cookies.push(String((init?.headers as Record<string, string> | undefined)?.Cookie ?? ""));
      }
      return new Response(JSON.stringify(route.body), { status: route.status });
    }) as typeof fetch;
    const driver = await createTokenCdpChatDriver({ sessionToken: SESSION_TOKEN, fetchImpl });
    const page = await driver.acquirePage();
    await page.snapshot();
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.every((cookie) => cookie === `__Secure-next-auth.session-token=${SESSION_TOKEN}`)).toBe(true);
  });

  it("throws when the session cookie is rejected", async () => {
    const options: TokenDriverOptions = {
      sessionToken: SESSION_TOKEN,
      fetchImpl: makeFetch([{ match: "/api/auth/session", status: 403, body: { error: "blocked" } }]),
    };
    const driver = await createTokenCdpChatDriver(options);
    const page = await driver.acquirePage();
    await expect(page.snapshot()).rejects.toThrow(/HTTP 403/);
  });

  it("requires a session token to be configured", async () => {
    await expect(createTokenCdpChatDriver({})).rejects.toThrow(/SESSION_TOKEN|SESSION_FILE/);
  });
});
