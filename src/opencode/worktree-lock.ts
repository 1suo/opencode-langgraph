import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const STALE_MS = 120_000;

function lockRoot(worktree: string): string {
  const stateBase = process.env.OPENCODE_LANGGRAPH_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const id = createHash("sha256").update(path.resolve(worktree)).digest("hex");
  return path.join(stateBase, "opencode-langgraph", "locks", id);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function alive(file: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    return processAlive(record.pid ?? 0) && Date.now() - fs.statSync(file).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

export interface WorktreeLease { release(): void }

export async function acquireWorktree(worktree: string, signal: AbortSignal, onWait?: (position: number) => void): Promise<WorktreeLease> {
  const root = lockRoot(worktree);
  const queue = path.join(root, "queue");
  const owner = path.join(root, "owner");
  fs.mkdirSync(queue, { recursive: true });
  const ticket = `${Date.now().toString().padStart(16, "0")}-${process.pid}-${randomUUID()}`;
  const ticketFile = path.join(queue, ticket);
  fs.writeFileSync(ticketFile, JSON.stringify({ pid: process.pid, worktree: path.resolve(worktree) }), { flag: "wx" });
  let timer: NodeJS.Timeout | undefined = setInterval(() => { try { fs.utimesSync(ticketFile, new Date(), new Date()); } catch { /* acquired or cancelled */ } }, 30_000);
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Graph run cancelled while queued");
      if (fs.existsSync(owner) && !alive(owner)) { try { fs.unlinkSync(owner); } catch { /* another waiter recovered it */ } }
      for (const name of fs.readdirSync(queue)) {
        const file = path.join(queue, name);
        if (!alive(file)) try { fs.unlinkSync(file); } catch { /* another waiter cleaned it */ }
      }
      const tickets = fs.readdirSync(queue).sort();
      const position = tickets.indexOf(ticket);
      if (position === 0) {
        try {
          fs.writeFileSync(owner, JSON.stringify({ ticket, pid: process.pid }), { flag: "wx" });
          fs.unlinkSync(ticketFile);
          clearInterval(timer);
          timer = setInterval(() => { try { fs.utimesSync(owner, new Date(), new Date()); } catch { /* released */ } }, 30_000);
          let released = false;
          return { release() {
            if (released) return;
            released = true;
            if (timer) clearInterval(timer);
            try {
              const current = JSON.parse(fs.readFileSync(owner, "utf8")) as { ticket: string };
              if (current.ticket === ticket) fs.unlinkSync(owner);
            } catch { /* already recovered or released */ }
          } };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      onWait?.(Math.max(1, position + 1));
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timeout = setTimeout(finish, 150);
        const abort = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Graph run cancelled while queued")); };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  } catch (error) {
    if (timer) clearInterval(timer);
    try { fs.unlinkSync(ticketFile); } catch { /* absent */ }
    throw error;
  }
}
