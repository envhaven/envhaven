import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import qrcode from 'qrcode-terminal';
import { pino } from 'pino';
import { safeSegment } from './claude.ts';

const ALL_GROUPS_FILE = 'data/all-groups.json';
export const ATTACHMENTS_DIR = 'data/attachments';

// Per-chat attachment directory: the SINGLE formula for where a chat's media lives.
// The writer (downloadAttachment) and the guest read-jail (index.ts) both derive their
// path from here, so the jail can never point somewhere other than where files land.
export const attachmentDir = (jid: string): string => resolve(ATTACHMENTS_DIR, safeSegment(jid));

/** A WhatsApp group JID. 1:1 chats are `@s.whatsapp.net` / `@lid`. The single
 *  home for "is this a group?" so callers never re-spell the suffix check. */
export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');

// Tight map of the mimetypes WhatsApp actually emits. Anything missing falls
// back to the original filename's extension or `.bin`.
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  // pickExt is exact-match; WhatsApp PTT emits the literal `audio/ogg; codecs=opus` string, hence its own key.
  'audio/ogg; codecs=opus': 'ogg',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

export type QuotedContext = {
  text: string;
  messageId?: string;
};

/**
 * The cheap fields (no media download) the admission gate needs. `IncomingMessage`
 * extends this, so one value satisfies both the pre-download `admit` check and the
 * full handler; the subset relationship is declared here rather than kept in sync by
 * hand between two independent shapes.
 */
export type AdmitInfo = {
  jid: string;
  /** Canonical sender id (LID number for `@lid` JIDs, phone number otherwise). */
  senderNumber: string;
  /**
   * Phone number resolved opportunistically from Baileys' `senderPn` field
   * or `chats.phoneNumberShare` events. Undefined when the sender's LID
   * hasn't been mapped to a phone yet (e.g. fresh boot, no shares observed).
   * Always equal to senderNumber for non-LID JIDs (omitted then to avoid noise).
   */
  senderPhoneNumber?: string;
  isGroup: boolean;
};

export type IncomingMessage = AdmitInfo & {
  text: string;
  raw: proto.IWebMessageInfo;
  quoted?: QuotedContext;
};

export type SendOpts = { quoted?: proto.IWebMessageInfo };

export type GroupAdd = {
  groupJid: string;
  groupName?: string;
  inviterNumber: string;
  /** Same opportunistic resolution as AdmitInfo.senderPhoneNumber. */
  inviterPhoneNumber?: string;
};

export type WhatsAppHandle = {
  /** Returns the live socket; swapped on reconnect. Don't cache the result. */
  getSock: () => WASocket;
  /** Resilient send: waits for an open connection and retries transient closures. */
  send: (jid: string, text: string, opts?: SendOpts) => Promise<void>;
  /** Best-effort presence update; never throws. */
  setTyping: (jid: string, on: boolean) => Promise<void>;
  /** LID number → resolved phone number, if Baileys has observed the mapping. Lets
   *  callers outside the message loop (flush, cron) match a phone-form OWNER_LID the
   *  same way the live admission gate does. */
  resolvePhone: (idNumber: string) => string | undefined;
};

// Silence Baileys' internal pino; connection.update gives us the events we care about.
const logger = pino({ level: 'silent' });

function extractTextFromMessage(m: proto.IMessage | null | undefined): string | null {
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || '[image]';
  if (m.videoMessage) return m.videoMessage.caption || '[video]';
  if (m.audioMessage) return '[voice note]';
  if (m.stickerMessage) return '[sticker]';
  if (m.documentMessage) return `[document: ${m.documentMessage.fileName ?? 'file'}]`;
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = m.documentWithCaptionMessage.message.documentMessage;
    return doc.caption || `[document: ${doc.fileName ?? 'file'}]`;
  }
  return null;
}

function jidToNumber(jid: string): string {
  return jid.split('@')[0]!.split(':')[0]!;
}

type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

function pickExt(mimetype: string | null | undefined, fileName?: string | null): string {
  if (mimetype && MIME_EXT[mimetype]) return MIME_EXT[mimetype]!;
  if (fileName) {
    const e = extname(fileName).slice(1).toLowerCase();
    if (e) return e;
  }
  return 'bin';
}

async function downloadAttachment(
  m: proto.IWebMessageInfo,
  kind: AttachmentKind,
  ext: string,
): Promise<string> {
  const jid = m.key.remoteJid!;
  // `m.key.id` is attacker-controlled (a scripted client sets any stanza id), so it
  // goes through safeSegment (see its definition for why that blocks traversal). The
  // assert below is a fail-closed backstop anchored to the attachments ROOT, so no
  // future change to id/ext/jid handling can land a write outside the attachments tree.
  const id = safeSegment(m.key.id!);
  const root = resolve(ATTACHMENTS_DIR);
  const dir = attachmentDir(jid);
  mkdirSync(dir, { recursive: true });
  const abs = resolve(dir, `${id}.${ext}`);
  if (!abs.startsWith(root + sep)) {
    throw new Error(`attachment path escaped the attachments dir: ${abs}`);
  }
  const buf = (await downloadMediaMessage(m, 'buffer', {})) as Buffer;
  writeFileSync(abs, buf, { mode: 0o600 });
  console.log(`  ↘ saved ${kind} (${buf.length} bytes)`);
  return abs;
}

// Recursive .md walk, callback-style so the caller can build a single
// concatenated corpus without holding all paths in memory.
async function walkMarkdown(dir: string, onText: (text: string) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      await walkMarkdown(p, onText);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try { onText(await readFile(p, 'utf-8')); } catch { /* unreadable */ }
    }
  }
}

// Age attachments under data/attachments/. An attachment survives if:
//   (a) its mtime is within maxDays (still recent), OR
//   (b) its basename appears anywhere in the durable-memory corpus
//       (SOUL/TOOLS/CLAUDE at cwd, recursive journal, recursive auto-memory).
// Same retention window as JOURNAL_DROP_DAYS so both data classes share one
// decision tree. Called from performFlush() once per daily reset.
export async function ageAttachments(opts: {
  cwd: string;
  journalDir: string;
  autoMemoryDir: string;
  maxDays?: number;
}): Promise<{ deleted: number; kept: number }> {
  const maxDays = opts.maxDays ?? 28;
  const cutoffMs = Date.now() - maxDays * 86_400_000;

  const parts: string[] = [];
  for (const name of ['SOUL.md', 'TOOLS.md', 'CLAUDE.md']) {
    try { parts.push(await readFile(resolve(opts.cwd, name), 'utf-8')); } catch { /* missing */ }
  }
  await walkMarkdown(opts.journalDir, (t) => parts.push(t));
  await walkMarkdown(opts.autoMemoryDir, (t) => parts.push(t));
  const corpus = parts.join('\n');

  let jidDirs: string[];
  try {
    jidDirs = await readdir(ATTACHMENTS_DIR);
  } catch {
    return { deleted: 0, kept: 0 };
  }
  let deleted = 0;
  let kept = 0;
  for (const jidName of jidDirs) {
    const jidDir = resolve(ATTACHMENTS_DIR, jidName);
    let files: string[];
    try {
      files = await readdir(jidDir);
    } catch {
      continue;
    }
    let surviving = 0;
    for (const name of files) {
      const file = resolve(jidDir, name);
      let mtimeMs: number;
      try { mtimeMs = (await stat(file)).mtimeMs; } catch { continue; }
      if (mtimeMs >= cutoffMs) { surviving++; continue; }
      if (corpus.includes(name)) { kept++; surviving++; continue; }
      try { await unlink(file); deleted++; } catch { surviving++; }
    }
    if (surviving === 0) {
      try { await rmdir(jidDir); } catch { /* not empty or already gone */ }
    }
  }
  return { deleted, kept };
}

async function extractMessageContent(m: proto.IWebMessageInfo): Promise<string | null> {
  const msg = m.message;
  if (!msg) return null;

  if (msg.audioMessage) {
    const abs = await downloadAttachment(m, 'audio', pickExt(msg.audioMessage.mimetype));
    return `[audio attached: ${abs}]`;
  }

  if (msg.imageMessage) {
    const abs = await downloadAttachment(m, 'image', pickExt(msg.imageMessage.mimetype));
    const cap = msg.imageMessage.caption?.trim();
    return cap ? `[image attached: ${abs}]\n${cap}` : `[image attached: ${abs}]`;
  }

  if (msg.videoMessage) {
    const abs = await downloadAttachment(m, 'video', pickExt(msg.videoMessage.mimetype));
    const cap = msg.videoMessage.caption?.trim();
    return cap ? `[video attached: ${abs}]\n${cap}` : `[video attached: ${abs}]`;
  }

  if (msg.stickerMessage) {
    const abs = await downloadAttachment(m, 'sticker', pickExt(msg.stickerMessage.mimetype) || 'webp');
    return `[sticker attached: ${abs}]`;
  }

  // documentWithCaptionMessage wraps documentMessage when WhatsApp sends a
  // file with a caption; the caption is on the outer wrapper, not the doc.
  const docWithCap = msg.documentWithCaptionMessage?.message?.documentMessage;
  if (docWithCap) {
    const ext = pickExt(docWithCap.mimetype, docWithCap.fileName);
    const abs = await downloadAttachment(m, 'document', ext);
    const name = docWithCap.fileName ?? `file.${ext}`;
    const cap = docWithCap.caption?.trim();
    const head = `[document attached: ${abs}; original name: ${name}]`;
    return cap ? `${head}\n${cap}` : head;
  }

  if (msg.documentMessage) {
    const ext = pickExt(msg.documentMessage.mimetype, msg.documentMessage.fileName);
    const abs = await downloadAttachment(m, 'document', ext);
    const name = msg.documentMessage.fileName ?? `file.${ext}`;
    const cap = msg.documentMessage.caption?.trim();
    const head = `[document attached: ${abs}; original name: ${name}]`;
    return cap ? `${head}\n${cap}` : head;
  }

  return extractTextFromMessage(msg);
}

async function dumpParticipatingGroups(sock: WASocket): Promise<void> {
  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups)
    .map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(dirname(ALL_GROUPS_FILE), { recursive: true });
  writeFileSync(ALL_GROUPS_FILE, JSON.stringify(list, null, 2));
  console.log(`Dumped ${list.length} participating group(s) to ${ALL_GROUPS_FILE}`);
}

function extractQuoted(msg: proto.IWebMessageInfo): QuotedContext | undefined {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return undefined;
  const text = extractTextFromMessage(ctx.quotedMessage);
  if (!text) return undefined;
  return { text, messageId: ctx.stanzaId ?? undefined };
}

type ConnState = 'connecting' | 'open' | 'closed' | 'logged-out';

const SEND_MAX_ATTEMPTS = 5;
const SEND_WAIT_OPEN_MS = 30_000;
const RECONNECT_DELAY_MS = 2_000;
const TRANSIENT_SEND_ERROR = /Connection Closed|Timed Out|Stream Errored|Connection Failure|connection-closed/i;

export async function startWhatsApp(
  onMessage: (msg: IncomingMessage) => void | Promise<void>,
  // Coarse pre-download admission. Consulted for every inbound message BEFORE any
  // media download or read receipt, so un-whitelisted senders / non-allowed groups
  // cause no disk write and no presence leak. Required: a bridge with no gate would
  // hand every stranger's message to Claude, so there is no safe default.
  admit: (info: AdmitInfo) => boolean,
  onGroupAdd?: (event: GroupAdd) => void | Promise<void>,
): Promise<WhatsAppHandle> {
  const { state: authState, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  // `sock` is swapped on every reconnect; the WhatsAppHandle reads through
  // getSock so callers never hold a stale reference.
  let sock: WASocket = null!;
  let connState: ConnState = 'connecting';
  const openWaiters: Array<() => void> = [];

  // LID → phone is in-memory only; populated from `chats.phoneNumberShare`
  // and `msg.key.senderPn`. LID-form whitelist entries don't need this map;
  // phone-form entries do, and may take a few messages post-restart to catch up.
  const lidToPhone = new Map<string, string>();
  function recordLidMapping(lidJid: string | undefined | null, phoneJid: string | undefined | null): void {
    if (!lidJid || !phoneJid) return;
    const lidNumber = jidToNumber(lidJid);
    const phoneNumber = jidToNumber(phoneJid);
    if (lidNumber && phoneNumber) lidToPhone.set(lidNumber, phoneNumber);
  }

  // Without this cache, WhatsApp re-encrypt retries see an empty proto and
  // recipients get stuck on "Waiting for this message…". Insertion-order
  // eviction; oldest sent are least likely to be retried.
  const SENT_MESSAGE_CACHE_MAX = 256;
  const sentMessageCache = new Map<string, proto.IMessage>();
  function cacheSentMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
    if (!id || !message) return;
    sentMessageCache.set(id, message);
    if (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
      const oldest = sentMessageCache.keys().next().value;
      if (oldest !== undefined) sentMessageCache.delete(oldest);
    }
  }

  // Bot's own LID, used to rewrite `@<botLid>` mentions to `@bot` before
  // Claude sees them. `\b` prevents `@12345` matching inside `@123456789`.
  let botLidUser: string | undefined;
  function rewriteBotMention(s: string): string {
    if (!botLidUser) return s;
    return s.replace(new RegExp(`@${botLidUser}\\b`, 'g'), '@bot');
  }

  function notifyOpen(): void {
    const waiters = openWaiters.splice(0);
    for (const w of waiters) {
      try {
        w();
      } catch (err) {
        console.error('open-waiter threw:', err);
      }
    }
  }

  function waitForOpen(timeoutMs: number): Promise<boolean> {
    if (connState === 'open') return Promise.resolve(true);
    if (connState === 'logged-out') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const handler = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = openWaiters.indexOf(handler);
        if (i >= 0) openWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      openWaiters.push(handler);
    });
  }

  function connect(): void {
    connState = 'connecting';
    sock = makeWASocket({
      version,
      auth: authState,
      browser: Browsers.macOS('Desktop'),
      logger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Serve recently-sent messages back to Baileys when WhatsApp asks
      // for re-encryption (retry requests). Returning undefined on miss
      // is safe; Baileys falls back to its own placeholder behavior.
      getMessage: async (key) => (key.id ? sentMessageCache.get(key.id) : undefined),
    });

    sock.ev.on('creds.update', saveCreds);

    // Whenever WhatsApp tells us about a LID↔phone share, cache it so
    // future whitelist matching and log lines can use phone numbers.
    // Cast to any because the event isn't in @whiskeysockets/baileys 6.7.18's
    // public types; EventEmitter.on silently no-ops on versions where the
    // event never fires.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sock.ev as any).on('chats.phoneNumberShare', (evt: { lid?: string; jid?: string }) => {
      recordLidMapping(evt?.lid, evt?.jid);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('\nScan this QR with WhatsApp > Settings > Linked Devices > Link a Device:\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connState = 'open';
        const me = sock.user?.id ? jidToNumber(sock.user.id) : '?';
        console.log(`✅ Connected to WhatsApp as ${me}`);
        // Capture bot's own LID and seed the LID→phone map with our own
        // mapping. The first powers @<lid> mention rewriting in groups;
        // the second is just the bot's own row in the resolution table.
        if (sock.user?.lid) {
          botLidUser = jidToNumber(sock.user.lid);
          if (sock.user.id) recordLidMapping(sock.user.lid, sock.user.id);
        }
        dumpParticipatingGroups(sock).catch((err) => {
          console.error('Failed to dump participating groups:', err);
        });
        notifyOpen();
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        connState = loggedOut ? 'logged-out' : 'closed';
        console.log(`Connection closed (code=${code}). ${loggedOut ? 'Logged out; delete auth/ and re-scan.' : 'Reconnecting…'}`);
        if (!loggedOut) {
          setTimeout(connect, RECONNECT_DELAY_MS);
        }
      }
    });

    if (onGroupAdd) {
      sock.ev.on('group-participants.update', async (update) => {
        if (update.action !== 'add') return;
        // sock.user has both `id` (phone-number JID) and `lid` (LID JID); group
        // events may reference the bot in either form, so check both.
        const botPhone = sock.user?.id ? jidToNumber(sock.user.id) : '';
        const botLid = sock.user?.lid ? jidToNumber(sock.user.lid) : '';
        const wasBotAdded = update.participants.some((p) => {
          const d = jidToNumber(p);
          return (botPhone && d === botPhone) || (botLid && d === botLid);
        });
        if (!wasBotAdded) return;
        const inviterJid = update.author;
        // System-initiated adds (rare but possible) leave author undefined;
        // skip rather than crash on jidToNumber(undefined).
        if (!inviterJid) return;
        let groupName: string | undefined;
        try {
          groupName = (await sock.groupMetadata(update.id)).subject;
        } catch {
          // metadata fetch failed; proceed without name
        }
        const inviterNumber = jidToNumber(inviterJid);
        const inviterPhoneNumber = inviterJid.endsWith('@lid')
          ? lidToPhone.get(inviterNumber)
          : undefined;
        try {
          await onGroupAdd({
            groupJid: update.id,
            groupName,
            inviterNumber,
            inviterPhoneNumber,
          });
        } catch (err) {
          console.error('onGroupAdd handler threw:', err);
        }
      });
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid) continue;
        // The bot's own messages never need processing, a download, or a receipt.
        if (m.key.fromMe) continue;

        // Opportunistic LID → phone resolution. `senderPn` rides on the message key
        // when WhatsApp folds the sender's phone JID into the envelope; not in the
        // public Baileys 6.7.18 types; cast to access. Recorded BEFORE admit so a
        // phone-form whitelist entry matches even the first message from a sender.
        const senderPn = (m.key as { senderPn?: string | null }).senderPn ?? undefined;
        const isGroup = isGroupJid(jid);
        const senderJid = isGroup ? (m.key.participant ?? jid) : jid;
        if (senderPn && senderJid.endsWith('@lid')) {
          recordLidMapping(senderJid, senderPn);
        }
        const senderNumber = jidToNumber(senderJid);
        const senderPhoneNumber = senderJid.endsWith('@lid')
          ? lidToPhone.get(senderNumber)
          : undefined;

        // ADMISSION BEFORE SIDE EFFECTS. Un-whitelisted senders and non-allowed
        // groups are dropped here, before any media touches disk and before a read
        // receipt is sent: hostile traffic costs no disk, leaks no presence, and can
        // never reach the attachment writer. handle() re-checks authoritatively.
        if (!admit({ jid, senderNumber, senderPhoneNumber, isGroup })) {
          console.log(
            `Ignored ${isGroup ? 'group ' : ''}message from ${senderNumber}` +
              `${senderPhoneNumber ? ` (+${senderPhoneNumber})` : ''}${isGroup ? ` in ${jid}` : ''} (not admitted)`,
          );
          continue;
        }

        // Read receipt only for admitted senders, so bot presence isn't confirmed to
        // strangers who merely know the number or share a group with the bot.
        sock.readMessages([m.key]).catch(() => undefined);

        let text: string | null;
        try {
          text = await extractMessageContent(m);
        } catch (err) {
          console.error('extractMessageContent failed:', err);
          text = `[error procesando mensaje: ${err instanceof Error ? err.message : String(err)}]`;
        }
        if (!text) continue;
        // Rewrite bot mentions in both the message body and any quoted context so
        // Claude sees `@bot` instead of a 15-digit LID; the text is purely cosmetic.
        text = rewriteBotMention(text);
        const quoted = extractQuoted(m);
        if (quoted) quoted.text = rewriteBotMention(quoted.text);

        try {
          await onMessage({
            jid,
            senderNumber,
            senderPhoneNumber,
            text,
            isGroup,
            raw: m,
            quoted,
          });
        } catch (err) {
          console.error('onMessage handler threw:', err);
        }
      }
    });
  }

  connect();

  // Without the retry loop, a mid-send `Connection Closed` between an
  // `open` event and the next blip silently drops the reply.
  async function send(jid: string, text: string, opts?: SendOpts): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      if (connState === 'logged-out') {
        throw new Error('logged-out; auth needs human action (rescan QR)');
      }
      if (connState !== 'open') {
        const ok = await waitForOpen(SEND_WAIT_OPEN_MS);
        if (!ok) {
          lastErr = new Error(`timed out waiting ${SEND_WAIT_OPEN_MS}ms for connection`);
          console.error(`[send] attempt ${attempt}/${SEND_MAX_ATTEMPTS}: ${(lastErr as Error).message}`);
          continue;
        }
      }
      try {
        const sent = await sock.sendMessage(jid, { text }, opts?.quoted ? { quoted: opts.quoted } : undefined);
        cacheSentMessage(sent?.key?.id, sent?.message);
        if (attempt > 1) console.log(`[send] succeeded on attempt ${attempt}`);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!TRANSIENT_SEND_ERROR.test(msg)) throw err;
        console.error(`[send] attempt ${attempt}/${SEND_MAX_ATTEMPTS} transient failure: ${msg}; will retry on reconnect`);
      }
    }
    throw lastErr ?? new Error('send: exhausted retries');
  }

  async function setTyping(jid: string, on: boolean): Promise<void> {
    if (connState !== 'open') return;
    try {
      await sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch {
      // Best-effort: typing indicator is a UX nicety, never abort callers.
    }
  }

  return { getSock: () => sock, send, setTyping, resolvePhone: (n) => lidToPhone.get(n) };
}
