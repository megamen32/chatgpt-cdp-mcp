export type OriginalSendState = "pending" | "unknown" | "sent";
export interface OriginalSendStatus {
    state: "unavailable" | "not_found" | "unknown" | "sent";
    chatRef: string;
    idempotencyKey: string;
    messageRef?: string;
    evidence?: "page_observed";
    recipientDeliveryConfirmed: false;
}
export declare class OriginalSendJournal {
    private readonly path;
    private readonly rows;
    constructor(path: string);
    private save;
    private validate;
    prepare(key: string, chatRef: string, text: string): void;
    markUnknown(key: string): void;
    markSent(key: string, messageRef: string): void;
    read(key: string, chatRef: string, text: string): OriginalSendStatus;
}
