// Markdown -> WhatsApp text formatting.
// WhatsApp uses: *bold*, _italic_, ~strike~, ```code```, `inline code`.

const CHUNK_LIMIT = 3500;

export function toWhatsApp(md: string): string {
  // Walk the string, leaving fenced code blocks (```...```) untouched.
  const out: string[] = [];
  let i = 0;
  while (i < md.length) {
    const fence = md.indexOf('```', i);
    if (fence === -1) {
      out.push(transformProse(md.slice(i)));
      break;
    }
    out.push(transformProse(md.slice(i, fence)));
    const close = md.indexOf('```', fence + 3);
    if (close === -1) {
      out.push(md.slice(fence)); // unterminated fence, leave as-is
      break;
    }
    out.push(md.slice(fence, close + 3));
    i = close + 3;
  }
  return out.join('');
}

function transformProse(s: string): string {
  // Order matters: bold (**) before italic (*) so we don't eat the bold markers.
  // Avoid touching backtick-inline-code.
  const segments: string[] = [];
  let i = 0;
  while (i < s.length) {
    const tick = s.indexOf('`', i);
    if (tick === -1) {
      segments.push(applyInline(s.slice(i)));
      break;
    }
    segments.push(applyInline(s.slice(i, tick)));
    const close = s.indexOf('`', tick + 1);
    if (close === -1) {
      segments.push(s.slice(tick));
      break;
    }
    segments.push(s.slice(tick, close + 1));
    i = close + 1;
  }
  return segments.join('');
}

function applyInline(s: string): string {
  let r = s;
  // Headings: leading `#`, `##`, etc. -> bold the line.
  r = r.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, '*$1*');
  // Bold **x** -> *x*
  r = r.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  // Italic *x* or _x_ -> _x_ (markdown italic uses single * which WhatsApp would read as bold)
  // Only convert single-* italics that are NOT part of bullets ("* item" at line start).
  r = r.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1_$2_');
  // Strikethrough ~~x~~ -> ~x~
  r = r.replace(/~~([^~\n]+?)~~/g, '~$1~');
  // Bullet lists: "- item" or "* item" -> "• item"
  r = r.replace(/^[ \t]*[-*][ \t]+/gm, '• ');
  return r;
}

export function chunk(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer splitting on a paragraph boundary, then a sentence, then a space.
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
