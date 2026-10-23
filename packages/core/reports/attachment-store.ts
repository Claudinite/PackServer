import { sha256Hex } from "@packserver/ports";
import { base64ToBytes, bytesToBase64, classifyAttachment, safeFileName, type AttachmentRefusal } from "./attachments.ts";
import { MAX_PENDING_ATTACHMENTS, PENDING_ATTACHMENT_TTL_HOURS } from "./constants.ts";
import { isoNow, type ReportPorts } from "./ports.ts";

/** A raw piece must stay well under a D1 row's size once it is base64. */
const CHUNK_BYTES = 384 * 1024;

export interface AttachmentMeta {
  id: string;
  name: string;
  content_type: string;
  disposition: "inline" | "attachment";
  size_bytes: number;
  sha256: string;
}

export type SaveAttachment =
  | { ok: true; attachment: AttachmentMeta }
  | { ok: false; reason: AttachmentRefusal | "too_many"; message: string };

/** Checks the file and keeps it until the report it belongs to is filed. */
export async function saveAttachment(ports: ReportPorts, upload: { user_id: string; name: string; bytes: Uint8Array }): Promise<SaveAttachment> {
  const verdict = classifyAttachment(upload);
  if (!verdict.ok) return verdict;

  const pending = await ports.d1.query("select count(*) as n from report_attachments where uploader_id = ? and report_id is null", [upload.user_id]);
  if (Number(pending.rows[0]?.n ?? 0) >= MAX_PENDING_ATTACHMENTS) {
    return { ok: false, reason: "too_many", message: "File or discard the reports you have started before attaching more files." };
  }

  const attachment: AttachmentMeta = {
    id: ports.rng.uuid(),
    name: safeFileName(upload.name),
    content_type: verdict.content_type,
    disposition: verdict.disposition,
    size_bytes: upload.bytes.length,
    sha256: await sha256Hex(upload.bytes),
  };
  const statements = [
    {
      sql: "insert into report_attachments (id, report_id, uploader_id, name, content_type, disposition, size_bytes, sha256, created_at) values (?, null, ?, ?, ?, ?, ?, ?, ?)",
      params: [attachment.id, upload.user_id, attachment.name, attachment.content_type, attachment.disposition, attachment.size_bytes, attachment.sha256, isoNow(ports)],
    },
  ];
  for (let seq = 0, at = 0; at < upload.bytes.length; seq += 1, at += CHUNK_BYTES) {
    statements.push({
      sql: "insert into report_attachment_chunks (attachment_id, seq, data) values (?, ?, ?)",
      params: [attachment.id, seq, bytesToBase64(upload.bytes.subarray(at, at + CHUNK_BYTES))] as never[],
    });
  }
  await ports.d1.batch(statements);
  return { ok: true, attachment };
}

export async function attachmentsOf(ports: ReportPorts, reportId: string): Promise<AttachmentMeta[]> {
  const { rows } = await ports.d1.query(
    "select id, name, content_type, disposition, size_bytes, sha256 from report_attachments where report_id = ? order by rowid",
    [reportId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    content_type: String(r.content_type),
    disposition: r.disposition === "attachment" ? "attachment" : "inline",
    size_bytes: Number(r.size_bytes),
    sha256: String(r.sha256),
  }));
}

export interface StoredAttachment extends AttachmentMeta {
  report_id: string | null;
  uploader_id: string;
  bytes: Uint8Array;
}

export async function loadAttachment(ports: ReportPorts, id: string): Promise<StoredAttachment | null> {
  const { rows } = await ports.d1.query(
    "select id, report_id, uploader_id, name, content_type, disposition, size_bytes, sha256 from report_attachments where id = ?",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const chunks = await ports.d1.query("select data from report_attachment_chunks where attachment_id = ? order by seq", [id]);
  const parts = chunks.rows.map((c) => base64ToBytes(String(c.data)));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return {
    id: String(row.id),
    report_id: row.report_id === null ? null : String(row.report_id),
    uploader_id: String(row.uploader_id),
    name: String(row.name),
    content_type: String(row.content_type),
    disposition: row.disposition === "attachment" ? "attachment" : "inline",
    size_bytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    bytes,
  };
}

/** Drops files that were uploaded and never attached. */
export async function discardStaleAttachments(ports: ReportPorts): Promise<number> {
  const cutoff = new Date(ports.clock.now() - PENDING_ATTACHMENT_TTL_HOURS * 3_600_000).toISOString();
  const stale = "select id from report_attachments where report_id is null and created_at < ?";
  const { rows } = await ports.d1.query(stale, [cutoff]);
  if (rows.length === 0) return 0;
  await ports.d1.batch([
    { sql: `delete from report_attachment_chunks where attachment_id in (${stale})`, params: [cutoff] },
    { sql: "delete from report_attachments where report_id is null and created_at < ?", params: [cutoff] },
  ]);
  return rows.length;
}
