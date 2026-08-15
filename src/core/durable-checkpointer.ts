import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";

function threadFromWriteKey(key: string): string | undefined {
  try { return JSON.parse(key)[0] as string; } catch { return; }
}

function encode(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __langgraphBytes: Buffer.from(value).toString("base64") };
  return value;
}

function decode(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__langgraphBytes" in value) return new Uint8Array(Buffer.from(String((value as { __langgraphBytes: unknown }).__langgraphBytes), "base64"));
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) return new Uint8Array((value as { data: number[] }).data);
  return value;
}

/** A dependency-free, atomic, per-thread persistent LangGraph saver. */
export class DurableFileSaver extends MemorySaver {
  constructor(readonly directory: string) {
    super();
  }

  private file(threadId: string): string {
    return path.join(this.directory, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  }

  private loadThread(threadId: string): void {
    const file = this.file(threadId);
    if (!fs.existsSync(file)) return;
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"), decode) as { threadId: string; storage: MemorySaver["storage"][string]; writes: MemorySaver["writes"] };
    if (snapshot.threadId !== threadId) throw new Error("Checkpoint thread hash collision");
    this.storage[threadId] = snapshot.storage;
    for (const key of Object.keys(this.writes)) if (threadFromWriteKey(key) === threadId) delete this.writes[key];
    Object.assign(this.writes, snapshot.writes);
  }

  private loadAll(): void {
    if (!fs.existsSync(this.directory)) return;
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const snapshot = JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8"), decode) as { threadId?: string };
        if (snapshot.threadId) this.loadThread(snapshot.threadId);
      } catch { /* ignore incomplete or externally edited checkpoints */ }
    }
  }

  private persistThread(threadId: string): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(threadId);
    const writes = Object.fromEntries(Object.entries(this.writes).filter(([key]) => threadFromWriteKey(key) === threadId));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ threadId, storage: this.storage[threadId] ?? {}, writes }, encode));
    fs.renameSync(temporary, file);
  }

  override async getTuple(config: Parameters<MemorySaver["getTuple"]>[0]) {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === "string") this.loadThread(threadId);
    return super.getTuple(config);
  }

  override async *list(config: Parameters<MemorySaver["list"]>[0], options?: Parameters<MemorySaver["list"]>[1]) {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === "string") this.loadThread(threadId); else this.loadAll();
    yield* super.list(config, options);
  }

  override async put(config: Parameters<MemorySaver["put"]>[0], checkpoint: Parameters<MemorySaver["put"]>[1], metadata: Parameters<MemorySaver["put"]>[2]) {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === "string") this.loadThread(threadId);
    const result = await super.put(config, checkpoint, metadata);
    this.persistThread(String(result.configurable?.thread_id));
    return result;
  }

  override async putWrites(config: Parameters<MemorySaver["putWrites"]>[0], writes: Parameters<MemorySaver["putWrites"]>[1], taskId: Parameters<MemorySaver["putWrites"]>[2]) {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId === "string") this.loadThread(threadId);
    await super.putWrites(config, writes, taskId);
    this.persistThread(String(threadId));
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    try { fs.unlinkSync(this.file(threadId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
