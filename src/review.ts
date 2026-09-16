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

function parseCommentNote(note, threadId, rootAuthor) {
  const opening = "\\cmtrpl";
  const firstReply = note.indexOf(opening);
  const rootBody = firstReply < 0 ? note : note.slice(0, firstReply).trimEnd();
  const replies = [];
  let valid = true;
  let cursor = firstReply;
  while (cursor >= 0 && cursor < note.length) {
    while (/\s/.test(note[cursor] || "")) cursor += 1;
    if (cursor >= note.length) break;
    if (!note.startsWith(opening, cursor)) {
      valid = false;
      break;
    }
    const id = parseBraced(note, cursor + opening.length);
    const author = id && parseBraced(note, id.end);
    const body = author && parseBraced(note, author.end);
    if (!id || !author || !body || !id.value || replies.some(reply => reply.id === id.value)) {
      valid = false;
      break;
    }
    replies.push({ id: id.value, author: author.value, body: body.value });
    cursor = body.end;
  }
  return {
    note: rootBody,
    replies,
    repliesValid: valid,
    messages: [
      { id: threadId, author: rootAuthor, body: rootBody, root: true },
      ...replies.map(reply => ({ ...reply, root: false })),
    ],
  };
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
    const comment = kind === "comment"
      ? parseCommentNote(note?.value ?? "", id.value, author.value)
      : null;
    items.push({
      kind,
      id: id.value,
      author: author.value,
      body: source.slice(author.end, closeAt),
      note: comment?.note ?? note?.value ?? "",
      replies: comment?.replies ?? [],
      repliesValid: comment?.repliesValid ?? true,
      messages: comment?.messages ?? [],
      from,
      bodyFrom: author.end,
      bodyTo: closeAt,
      replyInsertAt: note ? note.end - 1 : null,
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
