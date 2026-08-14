import type { Event, Permission } from "@opencode-ai/sdk";

type Handler = (permission: Permission) => Promise<void>;
const handlers = new Map<string, Handler>();

export function registerPermissionHandler(sessionId: string, handler: Handler): () => void {
  handlers.set(sessionId, handler);
  return () => { if (handlers.get(sessionId) === handler) handlers.delete(sessionId); };
}

export async function forwardPermissionEvent(event: Event): Promise<void> {
  if (event.type !== "permission.updated") return;
  await handlers.get(event.properties.sessionID)?.(event.properties);
}
