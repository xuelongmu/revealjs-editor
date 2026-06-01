const unorderedListPattern = /^(\s*)[-*+]\s+(.*)$/;
const orderedListPattern = /^(\s*)(\d+)([.)])\s+(.*)$/;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isSafeLinkUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function findClosingParen(value, startIndex) {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] === ")") return index;
  }
  return -1;
}

function findClosingBacktick(value, startIndex) {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] === "`") return index;
  }
  return -1;
}

export function renderInline(value) {
  let rendered = "";
  let index = 0;
  const source = String(value);

  while (index < source.length) {
    if (source[index] === "`") {
      const endIndex = findClosingBacktick(source, index + 1);
      if (endIndex > index + 1) {
        rendered += `<code>${escapeHtml(source.slice(index + 1, endIndex))}</code>`;
        index = endIndex + 1;
        continue;
      }
    }

    if (source.startsWith("~~", index)) {
      const endIndex = source.indexOf("~~", index + 2);
      if (endIndex > index + 2) {
        rendered += `<del>${renderInline(source.slice(index + 2, endIndex))}</del>`;
        index = endIndex + 2;
        continue;
      }
    }

    const strongToken = source.startsWith("**", index) ? "**" : source.startsWith("__", index) ? "__" : null;
    if (strongToken) {
      const endIndex = source.indexOf(strongToken, index + 2);
      if (endIndex > index + 2) {
        rendered += `<strong>${renderInline(source.slice(index + 2, endIndex))}</strong>`;
        index = endIndex + 2;
        continue;
      }
    }

    if (source[index] === "*" || source[index] === "_") {
      const token = source[index];
      const endIndex = source.indexOf(token, index + 1);
      if (endIndex > index + 1) {
        rendered += `<em>${renderInline(source.slice(index + 1, endIndex))}</em>`;
        index = endIndex + 1;
        continue;
      }
    }

    if (source[index] === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      if (labelEnd > index + 1) {
        const hrefEnd = findClosingParen(source, labelEnd + 2);
        if (hrefEnd > labelEnd + 2) {
          const label = source.slice(index + 1, labelEnd);
          const href = source.slice(labelEnd + 2, hrefEnd);
          if (isSafeLinkUrl(href)) {
            const target = href.startsWith("mailto:") ? "" : ' target="_blank" rel="noopener"';
            rendered += `<a class="copy-link" href="${escapeHtml(href)}"${target}>${renderInline(label)}</a>`;
          } else {
            rendered += escapeHtml(source.slice(index, hrefEnd + 1));
          }
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    const nextSpecial = ["`", "~~", "**", "__", "*", "_", "["]
      .map((token) => source.indexOf(token, index + 1))
      .filter((candidate) => candidate !== -1)
      .sort((left, right) => left - right)[0];
    const endIndex = nextSpecial ?? source.length;
    rendered += escapeHtml(source.slice(index, endIndex));
    index = endIndex;
  }

  return rendered;
}

function getListLine(line) {
  const unordered = line.match(unorderedListPattern);
  if (unordered) {
    return { type: "ul", text: unordered[2] };
  }

  const ordered = line.match(orderedListPattern);
  if (ordered) {
    return { type: "ol", text: ordered[4] };
  }

  return null;
}

function hasBlockMarkdown(lines, source) {
  return lines.some((line) => getListLine(line)) || /\n\s*\n/.test(source);
}

export function renderCopy(value) {
  const source = String(value).replace(/\r\n/g, "\n");
  const lines = source.split("\n");

  if (!hasBlockMarkdown(lines, source)) {
    return lines.map(renderInline).join("<br>");
  }

  const chunks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const listLine = getListLine(line);
    if (listLine) {
      const tag = listLine.type;
      const items = [];
      while (index < lines.length) {
        const current = getListLine(lines[index]);
        if (!current || current.type !== tag) break;
        items.push(`<li>${renderInline(current.text)}</li>`);
        index += 1;
      }
      chunks.push(`<${tag} class="copy-list">${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !getListLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    chunks.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
  }

  return chunks.join("");
}
