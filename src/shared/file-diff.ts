import { diffChars } from "diff";

export function fileChanges(base: string, updated: string) {
  if (base === updated) return [];
  let start = 0;
  let end = base.length;
  let updatedEnd = updated.length;
  while (start < end && start < updatedEnd && base[start] === updated[start]) start++;
  if (start && /[\uD800-\uDBFF]/.test(base[start - 1])) start--;
  while (end > start && updatedEnd > start && base[end - 1] === updated[updatedEnd - 1]) { end--; updatedEnd--; }
  if (end < base.length && /[\uDC00-\uDFFF]/.test(base[end])) { end++; updatedEnd++; }
  const fallback = [{ from: start, to: end, insert: updated.slice(start, updatedEnd) }];
  // Bound diff work for large rewrites; keep the unchanged prefix/suffix even then.
  const parts = diffChars(base.slice(start, end), updated.slice(start, updatedEnd), { timeout: 250, maxEditLength: 10_000 });
  if (!parts) return fallback;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let cursor = start;
  let pending: { from: number; to: number; insert: string } | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (pending) { changes.push(pending); pending = undefined; }
      cursor += part.value.length;
    } else {
      pending ??= { from: cursor, to: cursor, insert: "" };
      if (part.removed) { cursor += part.value.length; pending.to = cursor; }
      else pending.insert += part.value;
    }
  }
  if (pending) changes.push(pending);
  return changes.length > 1000 ? fallback : changes;
}
