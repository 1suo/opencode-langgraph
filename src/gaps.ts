export const GAP_OPEN = "/*<NEOLIT:GAP:";
export const GAP_CLOSE = "/*</NEOLIT:GAP:";

interface Range { id: string; start: number; contentStart: number; contentEnd: number; end: number }

function ranges(value: string): Range[] {
  const found: Range[] = [];
  const open = /\/\*<NEOLIT:GAP:([A-Za-z0-9_-]+)>\*\//g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(value))) {
    const closeText = `${GAP_CLOSE}${match[1]}>*/`;
    const close = value.indexOf(closeText, open.lastIndex);
    if (close < 0) throw new Error(`Missing closing gap marker ${match[1]}`);
    if (found.some((item) => item.id === match![1])) throw new Error(`Duplicate gap marker ${match[1]}`);
    found.push({ id: match[1], start: match.index, contentStart: open.lastIndex, contentEnd: close, end: close + closeText.length });
    open.lastIndex = close + closeText.length;
  }
  return found;
}

export function verifyAndMergeGaps(pristine: string, edited: string): string {
  const before = ranges(pristine);
  const after = ranges(edited);
  if (before.length === 0) {
    if (pristine !== edited) throw new Error("File without declared gaps changed");
    return pristine;
  }
  if (before.length !== after.length) throw new Error("Gap count changed");
  let merged = "";
  let cursor = 0;
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (a.id !== b.id) throw new Error("Gap order or identity changed");
    const pristineOutside = pristine.slice(cursor, a.contentStart);
    const editedOutside = edited.slice(index === 0 ? 0 : after[index - 1].contentEnd, b.contentStart);
    if (pristineOutside !== editedOutside) throw new Error(`Bytes outside gap ${a.id} changed`);
    merged += pristineOutside + edited.slice(b.contentStart, b.contentEnd);
    cursor = a.contentEnd;
  }
  const pristineTail = pristine.slice(cursor);
  const editedTail = edited.slice(after.at(-1)!.contentEnd);
  if (pristineTail !== editedTail) throw new Error("Bytes after final gap changed");
  return (merged + pristineTail).replace(/\/\*<\/?NEOLIT:GAP:[A-Za-z0-9_-]+>\*\//g, "");
}
