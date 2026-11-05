import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalSendJournal } from "../src/send-journal.js";

const roots: string[] = [];
const create = () => {
  const root=mkdtempSync(join(tmpdir(),"cdp-send-receipt-"));
  roots.push(root);
  const path=join(root,"send-ledger.json");
  return {root,path,journal:new OriginalSendJournal(path)};
};
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});

describe("original CDP send receipts",()=>{
  it("persists original identity before provider action, without storing message body",()=>{
    const {path,journal}=create();
    journal.prepare("draft-original","chat-ref","private fixture text");
    const disk=readFileSync(path,"utf8");
    expect(disk).not.toContain("private fixture text");
    expect(journal.read("draft-original","chat-ref","private fixture text").state).toBe("unknown");
    expect(new OriginalSendJournal(path).read("draft-original","chat-ref","private fixture text").state).toBe("unknown");
  });
  it("recovery of the exact positive receipt survives process restart",()=>{
    const {path,journal}=create();
    journal.prepare("draft-original","chat-ref","fixture message");
    journal.markSent("draft-original","cdpchat:v1:message:receipt");
    const status=new OriginalSendJournal(path).read("draft-original","chat-ref","fixture message");
    expect(status).toMatchObject({state:"sent",evidence:"page_observed",
      recipientDeliveryConfirmed:false,messageRef:"cdpchat:v1:message:receipt"});
  });
  it("lost response always remains UNKNOWN and can never be resent",()=>{
    const {path,journal}=create();
    journal.prepare("draft-original","chat-ref","fixture");
    journal.markUnknown("draft-original");
    const restarted=new OriginalSendJournal(path);
    expect(restarted.read("draft-original","chat-ref","fixture").state).toBe("unknown");
    expect(()=>restarted.prepare("draft-original","chat-ref","fixture")).toThrow(/already_submitted/);
  });
  it("different recipient or payload with the same key is never allowed",()=>{
    const {journal}=create();
    journal.prepare("draft-original","chat-ref","fixture");
    expect(()=>journal.prepare("draft-original","different-chat","fixture")).toThrow(/idempotency_conflict/);
    expect(()=>journal.prepare("draft-original","chat-ref","different-text")).toThrow(/idempotency_conflict/);
    expect(()=>journal.read("draft-original","different-chat","fixture")).toThrow(/idempotency_conflict/);
  });
  it("a late exception cannot downgrade an already confirmed send",()=>{
    const {journal}=create();
    journal.prepare("draft-original","chat-ref","fixture");
    journal.markSent("draft-original","native-receipt");
    journal.markUnknown("draft-original");
    expect(journal.read("draft-original","chat-ref","fixture").state).toBe("sent");
    expect(()=>journal.markSent("draft-original","foreign-receipt")).toThrow(/conflict/);
  });
  it("missing original key never proves absence of submission",()=>{
    const {journal}=create();
    expect(journal.read("missing","chat-ref","text").state).toBe("not_found");
  });
  it("corrupt journal fails closed instead of clearing durable identities",()=>{
    const {path,journal}=create();
    journal.prepare("draft-original","chat-ref","fixture");
    writeFileSync(path,"{broken");
    expect(()=>new OriginalSendJournal(path)).toThrow();
  });
  it("does not follow an untrusted journal symlink",()=>{
    const {root}=create();
    const target=join(root,"target.json");
    writeFileSync(target,"{}");
    const symlink=join(root,"untrusted.json");
    symlinkSync(target,symlink);
    expect(()=>new OriginalSendJournal(symlink)).toThrow();
  });
});
