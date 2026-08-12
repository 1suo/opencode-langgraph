import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AuditEvent, NodeStatus } from "./types.js";

export class RunEvents extends EventEmitter {
  readonly statuses = new Map<string, NodeStatus>();
  readonly logs: string[] = [];

  constructor(readonly runId: string, private readonly auditFile: string) {
    super();
  }

  record(event: Omit<AuditEvent, "at" | "runId">): void {
    const value: AuditEvent = { ...event, at: new Date().toISOString(), runId: this.runId };
    this.apply(value);
    fs.appendFileSync(this.auditFile, `${JSON.stringify(value)}\n`);
  }

  ingest(value: AuditEvent): void {
    this.apply(value);
  }

  private apply(value: AuditEvent): void {
    if (value.node && value.status) this.statuses.set(value.node, value.status);
    if (value.message) this.logs.push(value.message);
    this.emit("event", value);
  }

  node(name: string, status: NodeStatus, message?: string): void {
    this.record({ type: "node", node: name, status, message });
  }
}
