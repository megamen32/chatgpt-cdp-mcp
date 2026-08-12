/**
 * Runnable local demo driver. It proves MCP wiring without opening a browser or
 * contacting ChatGPT. Replace this module with your own CDP/browser adapter.
 */
const now = () => new Date().toISOString();

const chats = [
  {
    id: "demo-existing",
    title: "Existing ChatGPT conversation",
    unread: true,
    working: false,
    updatedAt: now(),
    messages: [{ id: "demo-message", role: "assistant", text: "This is a local demo snapshot.", version: 1, createdAt: now(), media: [] }],
  },
];

const identity = {
  origin: "https://chatgpt.com",
  accountRef: "demo-account",
  pageRef: "demo-page",
  leaseRef: "demo-lease",
};

const clone = (value) => structuredClone(value);

export function createCdpChatDriver() {
  return {
    async acquirePage() {
      return {
        async identity() { return clone(identity); },
        async snapshot() { return { chats: clone(chats) }; },
        async createChat({ title }) {
          const chat = {
            id: `demo-fixture-${chats.length + 1}`,
            title: title || "Disposable fixture",
            unread: false,
            working: false,
            updatedAt: now(),
            messages: [],
          };
          chats.push(chat);
          return clone(chat);
        },
        async sendMessage({ chatId, text }) {
          const chat = chats.find((entry) => entry.id === chatId);
          if (!chat) throw new Error("demo chat not found");
          const message = { id: `demo-message-${chat.messages.length + 1}`, role: "user", text, version: 1, createdAt: now(), media: [] };
          chat.messages.push(message);
          chat.updatedAt = now();
          return clone(message);
        },
        async editMessage({ chatId, messageId, text, expectedVersion, expectedText }) {
          const message = chats.find((entry) => entry.id === chatId)?.messages.find((entry) => entry.id === messageId);
          if (!message) throw new Error("demo message not found");
          if (expectedVersion !== undefined && message.version !== expectedVersion) throw new Error("demo version mismatch");
          if (expectedText !== undefined && message.text !== expectedText) throw new Error("demo text mismatch");
          message.text = text;
          message.version += 1;
          return clone(message);
        },
        async downloadMedia() { throw new Error("mock driver has no attachments"); },
      };
    },
  };
}
