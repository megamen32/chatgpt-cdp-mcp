export type ChatView = "unread" | "working" | "recent";
export interface PageIdentity {
    origin: string;
    accountRef: string;
    pageRef: string;
    leaseRef: string;
}
export interface MediaRecord {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
}
export interface MessageRecord {
    id: string;
    role: string;
    text: string;
    version: number;
    createdAt: string;
    media: MediaRecord[];
}
export interface ChatRecord {
    id: string;
    title: string;
    unread: boolean;
    working: boolean;
    updatedAt: string;
    messages: MessageRecord[];
}
export interface ChatSnapshot {
    chats: ChatRecord[];
}
export interface DownloadedMedia {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
}
/** The narrow page seam implemented by a BrowserClaw/CDP adapter. */
export interface CdpChatPage {
    identity(): Promise<PageIdentity>;
    snapshot(): Promise<ChatSnapshot>;
    createChat(input: {
        title?: string;
    }): Promise<ChatRecord>;
    sendMessage(input: {
        chatId: string;
        text: string;
    }): Promise<MessageRecord>;
    editMessage(input: {
        chatId: string;
        messageId: string;
        text: string;
        expectedVersion?: number;
        expectedText?: string;
    }): Promise<MessageRecord>;
    downloadMedia(input: {
        chatId: string;
        messageId: string;
        mediaId: string;
    }): Promise<DownloadedMedia>;
}
/** Acquires the one authenticated page owned by this MCP process. */
export interface CdpChatDriver {
    acquirePage(): Promise<CdpChatPage>;
}
export interface CdpChatOptions {
    mediaRoot?: string;
    recentWindowMs?: number;
    maxExportBytes?: number;
    maxMediaBytes?: number;
    allowedMediaTypes?: ReadonlySet<string>;
    writeGateTtlMs?: number;
    now?: () => number;
}
export interface NewChatInput {
    confirmation: string;
    idempotencyKey: string;
    title?: string;
}
export interface ListChatsInput {
    view: ChatView;
    limit?: number;
    cursor?: string;
}
export interface SearchChatInput {
    query: string;
    limit?: number;
}
export interface ExportChatInput {
    chatRef: string;
    format: "json" | "markdown";
    maxMessages?: number;
}
export interface SendMessageInput {
    chatRef: string;
    text: string;
    confirmation: string;
    idempotencyKey: string;
}
export interface EditMessageInput {
    chatRef: string;
    messageRef: string;
    text: string;
    confirmation: string;
    idempotencyKey: string;
    expectedVersion?: number;
    expectedText?: string;
}
export interface DownloadMediaInput {
    chatRef: string;
    messageRef: string;
    mediaRef: string;
    outputDir?: string;
}
export interface FixtureReceipt {
    origin: string;
    accountRef: string;
    pageRef: string;
    leaseRef: string;
    chatRef: string;
}
export interface PublicChat {
    chatRef: string;
    title: string;
    unread: boolean;
    working: boolean;
    updatedAt: string;
    fixtureBound: boolean;
    matchedMessageRefs?: string[];
}
export interface ListChatsResult {
    view: ChatView;
    semantics: string;
    chats: PublicChat[];
    nextCursor?: string;
}
export interface SearchChatResult {
    query: string;
    semantics: string;
    chats: PublicChat[];
}
export interface NewChatResult {
    chatRef: string;
    fixture: true;
    receipt: FixtureReceipt;
}
export interface ExportedMedia {
    mediaRef: string;
    filename: string;
    mimeType: string;
    size: number;
}
export interface ExportedMessage {
    messageRef: string;
    role: string;
    text: string;
    version: number;
    createdAt: string;
    media: ExportedMedia[];
}
export interface ExportChatResult {
    chatRef: string;
    format: "json" | "markdown";
    content: string;
    messages: ExportedMessage[];
    truncated: boolean;
}
export interface SendMessageResult {
    chatRef: string;
    messageRef: string;
    message: ExportedMessage;
}
export interface EditMessageResult {
    chatRef: string;
    messageRef: string;
    message: ExportedMessage;
}
export interface DownloadMediaResult {
    chatRef: string;
    messageRef: string;
    mediaRef: string;
    path: string;
    bytes: number;
    mimeType: string;
}
/** Error raised when the page, fixture, or bounded output policy is unsafe. */
export declare class CdpChatError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Standalone browser-chat adapter with fixture and page-lease safety. */
export declare class CdpChatClient {
    private readonly driver;
    private readonly options;
    private readonly refs;
    private readonly chatRefs;
    private readonly messageRefs;
    private readonly mediaRefs;
    private readonly gates;
    private boundIdentity?;
    private fixture?;
    private newChatInFlight;
    /** Construct a client around one injected CDP page driver. */
    constructor(driver: CdpChatDriver, options?: CdpChatOptions);
    /** Create and bind exactly one disposable fixture chat without submitting a prompt. */
    newChat(input: NewChatInput): Promise<NewChatResult>;
    /** List page-visible chats using explicit unread, working, or UTC-recent semantics. */
    listChats(input: ListChatsInput): Promise<ListChatsResult>;
    /** Search page-visible titles and message text without opening another tab. */
    searchChat(input: SearchChatInput): Promise<SearchChatResult>;
    /** Export a page-visible chat with message and byte limits. */
    exportChat(input: ExportChatInput): Promise<ExportChatResult>;
    /** Send exactly one message to a page-visible chat after consuming an exact one-shot gate. */
    sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
    /** Edit exactly one fixture message with an expected version or old-text guard. */
    editMessage(input: EditMessageInput): Promise<EditMessageResult>;
    /** Download one fixture attachment under a confined root and MIME/size allowlist. */
    downloadMedia(input: DownloadMediaInput): Promise<DownloadMediaResult>;
    /** Acquire and re-check one page lease around every operation. */
    private withPage;
    /** Consume a confirmation and idempotency key before any browser mutation. */
    private consumeGate;
    /** Map one raw page object to an opaque chat reference bound to its lease. */
    private rememberChat;
    /** Map one raw page message to an opaque reference tied to its chat and lease. */
    private rememberMessage;
    /** Map one raw attachment to an opaque reference tied to message and lease. */
    private rememberMedia;
    /** Convert a page chat to a bounded public record without exposing its raw ID. */
    private publicChat;
    /** Convert a page message and its attachments into export-safe opaque references. */
    private exportedMessage;
    /** Read the current snapshot and select one exact raw chat. */
    private findChat;
    /** Resolve a chat reference and require the disposable fixture binding. */
    private resolveChat;
    /** Resolve a message reference and bind it to the selected raw chat. */
    private resolveMessage;
    /** Resolve an attachment reference and bind it to the selected raw message. */
    private resolveMedia;
}
