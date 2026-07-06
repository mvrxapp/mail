import type { Address, Attachment, NormalizedEmail } from "@mvrx/aecs";

/**
 * D1 persistence for `NormalizedEmail` — see AECS-SDK-1 spec §3.7 (schema) and
 * §3.8 (query API). Raw D1 prepared statements only, no ORM.
 */

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * Column reference (verbatim from AECS-SDK-1 §3.7 — keep in sync with the
 * spec if it changes):
 *
 * CREATE TABLE IF NOT EXISTS mvrx_messages (
 *   message_id      TEXT PRIMARY KEY,
 *   thread_id       TEXT NOT NULL,
 *   from_email      TEXT NOT NULL,
 *   from_name       TEXT,
 *   to_json         TEXT,                 -- JSON: Address[] — NormalizedEmail.metadata.to
 *   cc_json         TEXT,                 -- JSON: Address[] — metadata.cc
 *   bcc_json        TEXT,                 -- JSON: Address[] — metadata.bcc
 *   subject         TEXT,
 *   timestamp       INTEGER NOT NULL,     -- Unix epoch seconds — metadata.timestamp
 *   content_raw     TEXT,                 -- content.raw
 *   content_text    TEXT,                 -- content.text
 *   content_clean   TEXT,                 -- content.clean
 *   content_forai   TEXT,                 -- content.forAI
 *   content_html    TEXT,                 -- content.html
 *   raw_key         TEXT,                 -- R2 key for content.rawFull; null if not stored
 *   in_reply_to     TEXT,                 -- thread.inReplyTo
 *   references_json TEXT,                 -- JSON: string[] — thread.references
 *   processed_at    TEXT NOT NULL,
 *   x_fields        TEXT                  -- JSON blob for all x_ extension fields
 * );
 *
 * CREATE TABLE IF NOT EXISTS mvrx_threads (
 *   thread_id     TEXT PRIMARY KEY,
 *   subject       TEXT,
 *   first_at      INTEGER NOT NULL,
 *   last_at       INTEGER NOT NULL,
 *   message_count INTEGER NOT NULL DEFAULT 1
 * );
 *
 * CREATE TABLE IF NOT EXISTS mvrx_attachments (
 *   id             TEXT PRIMARY KEY,     -- Attachment.id, e.g. "<messageId>:0"
 *   message_id     TEXT NOT NULL REFERENCES mvrx_messages(message_id),
 *   filename       TEXT NOT NULL,
 *   content_type   TEXT NOT NULL,
 *   size           INTEGER NOT NULL,
 *   cid            TEXT,                 -- Content-ID for inline attachments; null otherwise
 *   blob_key       TEXT,                 -- R2 key; null if not stored
 *   extracted_text TEXT
 * );
 *
 * CREATE INDEX IF NOT EXISTS mvrx_msg_thread ON mvrx_messages(thread_id, timestamp);
 * CREATE INDEX IF NOT EXISTS mvrx_msg_from   ON mvrx_messages(from_email, timestamp);
 * CREATE INDEX IF NOT EXISTS mvrx_msg_time   ON mvrx_messages(timestamp DESC);
 *
 * `D1Database.exec()` splits its input on newlines and requires each
 * statement to be fully self-contained on one line (it does not split on
 * `;`), so the executable version below is a single-line-per-statement,
 * comment-free rendering of the exact same DDL as above.
 */
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS mvrx_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_email TEXT NOT NULL, from_name TEXT, to_json TEXT, cc_json TEXT, bcc_json TEXT, subject TEXT, timestamp INTEGER NOT NULL, content_raw TEXT, content_text TEXT, content_clean TEXT, content_forai TEXT, content_html TEXT, raw_key TEXT, in_reply_to TEXT, references_json TEXT, processed_at TEXT NOT NULL, x_fields TEXT)",
  "CREATE TABLE IF NOT EXISTS mvrx_threads (thread_id TEXT PRIMARY KEY, subject TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 1)",
  "CREATE TABLE IF NOT EXISTS mvrx_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES mvrx_messages(message_id), filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, cid TEXT, blob_key TEXT, extracted_text TEXT)",
  "CREATE INDEX IF NOT EXISTS mvrx_msg_thread ON mvrx_messages(thread_id, timestamp)",
  "CREATE INDEX IF NOT EXISTS mvrx_msg_from ON mvrx_messages(from_email, timestamp)",
  "CREATE INDEX IF NOT EXISTS mvrx_msg_time ON mvrx_messages(timestamp DESC)",
  "CREATE TABLE IF NOT EXISTS mvrx_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, conditions TEXT NOT NULL, condition_mode TEXT NOT NULL DEFAULT 'all', actions TEXT NOT NULL, rule_order INTEGER NOT NULL DEFAULT 0)",
];

/**
 * Creates the mvrx_messages / mvrx_threads / mvrx_attachments tables and their
 * indexes. Idempotent — safe to call on every Worker startup.
 */
export async function d1Init(db: D1Database): Promise<void> {
  await db.exec(SCHEMA_STATEMENTS.join("\n"));
}

// ── Row shapes ───────────────────────────────────────────────────────────────

interface MessageRow {
  message_id: string;
  thread_id: string;
  from_email: string;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string | null;
  timestamp: number;
  content_raw: string | null;
  content_text: string | null;
  content_clean: string | null;
  content_forai: string | null;
  content_html: string | null;
  raw_key: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  processed_at: string;
  x_fields: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  cid: string | null;
  blob_key: string | null;
  extracted_text: string | null;
}

/**
 * Internal bookkeeping stashed inside the `x_fields` JSON blob under a
 * reserved (non `x_`-prefixed) key, so it never collides with real AECS-1
 * `x_` extension fields.
 *
 * SPEC AMBIGUITY — timestamp/specVersion round-trip:
 * The schema's `timestamp` column is NOT NULL, but `metadata.timestamp` is
 * nullable (and `d1Store` falls back to `processing.processedAt` when it's
 * null, per §3.7). There is also no `spec_version` column at all. To give
 * `getMessage`/`getThread`/`listMessages` a truly lossless round trip for
 * both of these (rather than guessing "was this null?" from data alone, or
 * hardcoding a spec version on read), we stash a small internal object in
 * `x_fields` recording whether the timestamp was originally null and what
 * `processing.specVersion` was. Rows inserted directly via SQL (bypassing
 * `d1Store`, which the spec explicitly allows) simply won't have this
 * marker — reads fall back to treating `timestamp` as authoritative and
 * `specVersion` as `DEFAULT_SPEC_VERSION` in that case.
 */
interface StorageMeta {
  timestampWasNull: boolean;
  specVersion: string;
}

const DEFAULT_SPEC_VERSION = "1.0";

function encodeXFields(meta: StorageMeta): string {
  return JSON.stringify({ _mvrxStorageMeta: meta });
}

function decodeXFields(xFields: string | null): StorageMeta {
  if (!xFields) {
    return { timestampWasNull: false, specVersion: DEFAULT_SPEC_VERSION };
  }
  try {
    const parsed = JSON.parse(xFields) as { _mvrxStorageMeta?: Partial<StorageMeta> };
    const meta = parsed._mvrxStorageMeta;
    return {
      timestampWasNull: meta?.timestampWasNull ?? false,
      specVersion: meta?.specVersion ?? DEFAULT_SPEC_VERSION,
    };
  } catch {
    return { timestampWasNull: false, specVersion: DEFAULT_SPEC_VERSION };
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

/**
 * Upserts a message row, upserts its parent thread row (first_at/last_at/
 * message_count), and upserts its attachment rows.
 */
export async function d1Store(db: D1Database, email: NormalizedEmail): Promise<void> {
  const timestampWasNull = email.metadata.timestamp === null;
  const timestamp = timestampWasNull
    ? Math.floor(Date.parse(email.processing.processedAt) / 1000)
    : (email.metadata.timestamp as number);

  const xFields = encodeXFields({
    timestampWasNull,
    specVersion: email.processing.specVersion,
  });

  // Determine whether this message already exists so the thread's
  // message_count isn't double-incremented on a re-store (e.g. reprocessing
  // the same inbound email). This check runs before the atomic batch below,
  // so it isn't itself serialized against concurrent writers for the same
  // message_id — acceptable for the single-writer-per-message pattern email
  // ingestion follows, but worth knowing if you call d1Store concurrently
  // for the same messageId.
  const existing = await db
    .prepare("SELECT 1 FROM mvrx_messages WHERE message_id = ?")
    .bind(email.messageId)
    .first();
  const isNewMessage = existing === null;

  const messageStmt = db
    .prepare(
      `INSERT INTO mvrx_messages (
        message_id, thread_id, from_email, from_name, to_json, cc_json, bcc_json,
        subject, timestamp, content_raw, content_text, content_clean, content_forai,
        content_html, raw_key, in_reply_to, references_json, processed_at, x_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        from_email = excluded.from_email,
        from_name = excluded.from_name,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json,
        subject = excluded.subject,
        timestamp = excluded.timestamp,
        content_raw = excluded.content_raw,
        content_text = excluded.content_text,
        content_clean = excluded.content_clean,
        content_forai = excluded.content_forai,
        content_html = excluded.content_html,
        raw_key = excluded.raw_key,
        in_reply_to = excluded.in_reply_to,
        references_json = excluded.references_json,
        processed_at = excluded.processed_at,
        x_fields = excluded.x_fields`
    )
    .bind(
      email.messageId,
      email.threadId,
      email.metadata.from.email,
      email.metadata.from.name,
      JSON.stringify(email.metadata.to),
      JSON.stringify(email.metadata.cc),
      JSON.stringify(email.metadata.bcc),
      email.metadata.subject,
      timestamp,
      email.content.raw,
      email.content.text,
      email.content.clean,
      email.content.forAI,
      email.content.html,
      null, // raw_key — content.rawFull is not stored inline (§3.7)
      email.thread.inReplyTo,
      JSON.stringify(email.thread.references),
      email.processing.processedAt,
      xFields
    );

  const threadStmt = db
    .prepare(
      `INSERT INTO mvrx_threads (thread_id, subject, first_at, last_at, message_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(thread_id) DO UPDATE SET
         subject = COALESCE(mvrx_threads.subject, excluded.subject),
         first_at = MIN(mvrx_threads.first_at, excluded.first_at),
         last_at = MAX(mvrx_threads.last_at, excluded.last_at),
         message_count = mvrx_threads.message_count + ?`
    )
    .bind(email.threadId, email.metadata.subject, timestamp, timestamp, isNewMessage ? 1 : 0);

  const attachmentStmts = email.attachments.map((attachment) =>
    db
      .prepare(
        `INSERT INTO mvrx_attachments (id, message_id, filename, content_type, size, cid, blob_key, extracted_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           message_id = excluded.message_id,
           filename = excluded.filename,
           content_type = excluded.content_type,
           size = excluded.size,
           cid = excluded.cid,
           blob_key = excluded.blob_key,
           extracted_text = excluded.extracted_text`
      )
      .bind(
        attachment.id,
        email.messageId,
        attachment.filename,
        attachment.contentType,
        attachment.size,
        attachment.cid,
        attachment.blobKey ?? null,
        attachment.extractedText ?? null
      )
  );

  await db.batch([messageStmt, threadStmt, ...attachmentStmts]);
}

// ── Read ─────────────────────────────────────────────────────────────────────

function attachmentFromRow(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    cid: row.cid,
    // D1 only stores a pointer (blob_key) to the attachment bytes, never the
    // bytes themselves — fetch them from your BlobStore using blobKey.
    content: async () => {
      throw new Error(
        `Attachment "${row.id}" content is not stored in D1 — fetch it via blobKey ` +
          `("${row.blob_key ?? "null"}") from your BlobStore.`
      );
    },
    extractedText: row.extracted_text,
    blobKey: row.blob_key,
  };
}

function rowToNormalizedEmail(row: MessageRow, attachmentRows: AttachmentRow[]): NormalizedEmail {
  const meta = decodeXFields(row.x_fields);

  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    metadata: {
      from: { name: row.from_name, email: row.from_email },
      to: JSON.parse(row.to_json ?? "[]") as Address[],
      cc: JSON.parse(row.cc_json ?? "[]") as Address[],
      bcc: JSON.parse(row.bcc_json ?? "[]") as Address[],
      subject: row.subject,
      // `date` has no dedicated column; it's re-derived from `timestamp`
      // (same instant, ISO-formatted) since the two are only ever null
      // together (AECS-1 §6). Not a byte-for-byte round trip of the
      // original Date header string, but faithful to null/non-null status
      // and to the instant it represents.
      date: meta.timestampWasNull ? null : new Date(row.timestamp * 1000).toISOString(),
      timestamp: meta.timestampWasNull ? null : row.timestamp,
    },
    content: {
      rawFull: null, // not stored inline — fetch via raw_key from your BlobStore
      raw: row.content_raw,
      html: row.content_html,
      text: row.content_text,
      clean: row.content_clean,
      forAI: row.content_forai,
    },
    thread: {
      // Filled in by getThread() (via EmailThread.from); null for single-row
      // lookups (getMessage) and arbitrary pages (listMessages) per §3.8.
      position: null,
      inReplyTo: row.in_reply_to,
      references: JSON.parse(row.references_json ?? "[]") as string[],
    },
    attachments: attachmentRows.map(attachmentFromRow),
    processing: {
      processedAt: row.processed_at,
      specVersion: meta.specVersion,
    },
  };
}

/** Fetches attachment rows for a set of message ids in one query. */
async function fetchAttachmentsFor(
  db: D1Database,
  messageIds: string[]
): Promise<Map<string, AttachmentRow[]>> {
  const byMessage = new Map<string, AttachmentRow[]>();
  if (messageIds.length === 0) return byMessage;

  const placeholders = messageIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM mvrx_attachments WHERE message_id IN (${placeholders}) ORDER BY rowid ASC`
    )
    .bind(...messageIds)
    .all<AttachmentRow>();

  for (const row of results) {
    const bucket = byMessage.get(row.message_id);
    if (bucket) {
      bucket.push(row);
    } else {
      byMessage.set(row.message_id, [row]);
    }
  }
  return byMessage;
}

/** Single message by Message-ID. `thread.position` is always null (§3.8). */
export async function getMessage(db: D1Database, messageId: string): Promise<NormalizedEmail | null> {
  const row = await db
    .prepare("SELECT * FROM mvrx_messages WHERE message_id = ?")
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return null;

  const attachmentRows = (
    await db
      .prepare("SELECT * FROM mvrx_attachments WHERE message_id = ? ORDER BY rowid ASC")
      .bind(messageId)
      .all<AttachmentRow>()
  ).results;

  return rowToNormalizedEmail(row, attachmentRows);
}

/**
 * All messages in a thread, sorted by `metadata.timestamp` ascending, with
 * `thread.position` computed and assigned (0-based index — §5.2). Returns an
 * empty array if the thread has no stored messages. Callers wrap this with
 * `EmailThread.from(messages)` when they need thread-level helpers (§3.8).
 */
export async function getThread(db: D1Database, threadId: string): Promise<NormalizedEmail[]> {
  const { results } = await db
    .prepare("SELECT * FROM mvrx_messages WHERE thread_id = ? ORDER BY timestamp ASC")
    .bind(threadId)
    .all<MessageRow>();
  if (results.length === 0) return [];

  const attachmentsByMessage = await fetchAttachmentsFor(
    db,
    results.map((row) => row.message_id)
  );
  // getThread() has every message in the thread, so it can compute position
  // (unlike getMessage/listMessages, which leave it null — §3.8).
  return results.map((row, index) => {
    const email = rowToNormalizedEmail(row, attachmentsByMessage.get(row.message_id) ?? []);
    email.thread.position = index;
    return email;
  });
}

/** Options for `listMessages` — cursor-based pagination (§3.8). */
export interface ListMessagesOptions {
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Default: 50, max: 100. */
  limit?: number;
  /** Filter by exact sender email. */
  from?: string;
  /** Restrict to one thread. */
  threadId?: string;
  /** Unix timestamp lower bound (inclusive). */
  since?: number;
  /** Unix timestamp upper bound (exclusive). */
  until?: number;
  /** Default: "desc" (newest first). */
  order?: "asc" | "desc";
}

/** A page of messages plus the cursor for the next page (§3.8). */
export interface MessagePage {
  messages: NormalizedEmail[];
  /** `null` when this is the last page. */
  nextCursor: string | null;
}

/** The composite sort key encoded into an opaque `listMessages` cursor. */
interface Cursor {
  t: number;
  id: string;
}

function encodeCursor(row: MessageRow): string {
  const cursor: Cursor = { t: row.timestamp, id: row.message_id };
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(cursor: string): Cursor {
  return JSON.parse(atob(cursor)) as Cursor;
}

/**
 * Paginated message list, cursor-based so it's stable under concurrent inserts
 * (§3.8). `thread.position` is always null on returned messages — an arbitrary
 * page may span multiple threads, so siblings aren't available to compute it.
 */
export async function listMessages(
  db: D1Database,
  options: ListMessagesOptions = {}
): Promise<MessagePage> {
  const limit = Math.min(options.limit ?? 50, 100);
  const asc = options.order === "asc";
  const dir = asc ? "ASC" : "DESC";
  // Composite comparison operator for the cursor: pages continue strictly
  // past the (timestamp, message_id) of the last row seen.
  const cmp = asc ? ">" : "<";

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.threadId !== undefined) {
    clauses.push("thread_id = ?");
    params.push(options.threadId);
  }
  if (options.from !== undefined) {
    clauses.push("from_email = ?");
    params.push(options.from);
  }
  if (options.since !== undefined) {
    clauses.push("timestamp >= ?");
    params.push(options.since);
  }
  if (options.until !== undefined) {
    clauses.push("timestamp < ?");
    params.push(options.until);
  }
  if (options.cursor !== undefined) {
    const { t, id } = decodeCursor(options.cursor);
    clauses.push(`(timestamp ${cmp} ? OR (timestamp = ? AND message_id ${cmp} ?))`);
    params.push(t, t, id);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  // Fetch one extra row to detect whether a further page exists.
  const sql = `SELECT * FROM mvrx_messages ${where} ORDER BY timestamp ${dir}, message_id ${dir} LIMIT ?`;

  const { results } = await db
    .prepare(sql)
    .bind(...params, limit + 1)
    .all<MessageRow>();

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null;

  const attachmentsByMessage = await fetchAttachmentsFor(
    db,
    pageRows.map((row) => row.message_id)
  );
  const messages = pageRows.map((row) =>
    rowToNormalizedEmail(row, attachmentsByMessage.get(row.message_id) ?? [])
  );

  return { messages, nextCursor };
}
