export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) return serialized;
  } catch {}
  return String(error);
}
