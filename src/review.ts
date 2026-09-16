function parseBraced(source, start) {
  if (source[start] !== "{") return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return { value: source.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function parseReviewKind(source, kind, opening, closing, closingHasArgument) {
  const items = [];
  let cursor = 0;
  while (cursor < source.length) {
    const from = source.indexOf(opening, cursor);
    if (from < 0) break;
    const id = parseBraced(source, from + opening.length);
    const author = id && parseBraced(source, id.end);
    if (!id || !author) { cursor = from + opening.length; continue; }
    const closeAt = source.indexOf(closing, author.end);
    if (closeAt < 0) break;
    const note = closingHasArgument ? parseBraced(source, closeAt + closing.length) : null;
    if (closingHasArgument && !note) { cursor = closeAt + closing.length; continue; }
    const to = note?.end ?? closeAt + closing.length;
    items.push({
      kind,
      id: id.value,
      author: author.value,
      body: source.slice(author.end, closeAt),
      note: note?.value ?? "",
      from,
      bodyFrom: author.end,
      bodyTo: closeAt,
      to,
    });
    cursor = to;
  }
  return items;
}

export function parseReviews(source) {
  return [
    ...parseReviewKind(source, "comment", "\\cmtbg", "\\cmted", true),
    ...parseReviewKind(source, "revision", "\\revbg", "\\reved", true),
    ...parseReviewKind(source, "addition", "\\addbg", "\\added", false),
    ...parseReviewKind(source, "deletion", "\\delbg", "\\deled", false),
  ]
    .sort((left, right) => left.from - right.from);
}

export function stripReviewStorage(source) {
  const reviews = parseReviews(source);
  let visible = source;
  for (const item of reviews.reverse()) {
    const body = item.kind === "deletion" ? "" : item.body;
    visible = `${visible.slice(0, item.from)}${body}${visible.slice(item.to)}`;
  }
  return visible;
}
