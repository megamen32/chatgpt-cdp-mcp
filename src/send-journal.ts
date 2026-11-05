/**
 * Durable, account-local record of ORIGINAL CDP message submissions.
 * Each idempotency key can cross the provider boundary at most once, even
 * across MCP process restarts. UNKNOWN is never permission to send again.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
         openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type OriginalSendState = "pending" | "unknown" | "sent";
export interface OriginalSendStatus {
  state: "unavailable" | "not_found" | "unknown" | "sent";
  chatRef: string;
  idempotencyKey: string;
  messageRef?: string;
  evidence?: "page_observed";
  recipientDeliveryConfirmed: false;
}
type Entry = {
  key: string;
  chatRef: string;
  textSha256: string;
  state: OriginalSendState;
  createdAt: number;
  messageRef?: string;
};
function valid(value: string, length: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= length;
}
function hash(text: string) { return createHash("sha256").update(text).digest("hex"); }

export class OriginalSendJournal {
  private readonly path: string;
  private readonly rows = new Map<string, Entry>();
  constructor(path: string) {
    if (!valid(path, 4096)) throw new Error("CDP send journal path required");
    this.path = resolve(path);
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || (parentStat.mode & 0o077) !== 0) throw new Error("CDP journal directory must be private");
    if (!existsSync(this.path)) return;
    const st = lstatSync(this.path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) {
      throw new Error("CDP send journal is not a private regular file");
    }
    const value = JSON.parse(readFileSync(this.path,"utf8")) as { schema?: unknown; rows?: unknown };
    if (value?.schema !== 1 || !Array.isArray(value.rows)) throw new Error("CDP send journal invalid");
    for (const unknownRow of value.rows) {
      const row = unknownRow as Entry;
      if (!row || !valid(row.key,128) || !valid(row.chatRef,256)
          || !/^[a-f0-9]{64}$/.test(row.textSha256)
          || !["pending","unknown","sent"].includes(row.state)
          || (row.state==="sent" && !valid(row.messageRef || "",256))
          || this.rows.has(row.key)) {
        throw new Error("CDP send journal corrupt or contains duplicate key");
      }
      this.rows.set(row.key,row);
    }
  }
  private save() {
    const temp=this.path+".tmp-"+randomUUID();
    let fd: number | null=null, folder: number | null=null;
    try {
      fd=openSync(temp,"wx",0o600);
      writeFileSync(fd,JSON.stringify({schema:1,rows:[...this.rows.values()]}));
      fsyncSync(fd);closeSync(fd);fd=null;
      renameSync(temp,this.path);
      folder=openSync(dirname(this.path),"r");fsyncSync(folder);
    } finally {
      if (fd!==null) closeSync(fd);
      if (folder!==null) closeSync(folder);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private validate(key: string,chatRef: string,text: string) {
    if (!valid(key,128) || !valid(chatRef,256)
        || typeof text!=="string" || !text.trim() || text.length>100000) {
      throw new Error("original CDP request identity invalid");
    }
    return hash(text);
  }
  prepare(key: string,chatRef: string,text: string) {
    const textSha256=this.validate(key,chatRef,text);
    const existing=this.rows.get(key);
    if (existing) {
      if (existing.chatRef!==chatRef || existing.textSha256!==textSha256) {
        throw new Error("idempotency_conflict");
      }
      throw new Error("original_send_already_submitted");
    }
    if (this.rows.size>=100000) throw new Error("CDP journal capacity reached; refuse new sends");
    const row: Entry={key,chatRef,textSha256,state:"pending",createdAt:Date.now()};
    this.rows.set(key,row);
    try { this.save(); } catch(error) { this.rows.delete(key); throw error; }
  }
  markUnknown(key: string) {
    const row=this.rows.get(key);
    if (!row || row.state==="sent") return;
    const before={...row};
    row.state="unknown";
    try { this.save(); } catch(error) { this.rows.set(key,before); throw error; }
  }
  markSent(key: string,messageRef: string) {
    if (!valid(messageRef,256)) throw new Error("CDP sent messageRef missing");
    const row=this.rows.get(key);
    if (!row) throw new Error("CDP original send not recorded");
    if (row.state==="sent" && row.messageRef!==messageRef) throw new Error("CDP provider receipt conflict");
    const before={...row};
    row.state="sent";row.messageRef=messageRef;
    try { this.save(); } catch(error) { this.rows.set(key,before); throw error; }
  }
  read(key: string,chatRef: string,text: string): OriginalSendStatus {
    const textSha256=this.validate(key,chatRef,text);
    const row=this.rows.get(key);
    if (!row) return {state:"not_found",idempotencyKey:key,chatRef,recipientDeliveryConfirmed:false};
    if (row.chatRef!==chatRef || row.textSha256!==textSha256) {
      throw new Error("idempotency_conflict");
    }
    if (row.state==="sent") {
      return {state:"sent",idempotencyKey:key,chatRef,messageRef:row.messageRef,
        evidence:"page_observed",recipientDeliveryConfirmed:false};
    }
    return {state:"unknown",idempotencyKey:key,chatRef,recipientDeliveryConfirmed:false};
  }
}
