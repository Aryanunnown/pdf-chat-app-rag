import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { buildTfidfIndex } from './retrieval.js';

function pick(obj, names, fallback = undefined) {
  for (const name of names) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== null && obj[name] !== undefined) {
      return obj[name];
    }
  }
  return fallback;
}

function isMissingColumnError(error) {
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('does not exist') && msg.includes('column');
}

function isSchemaCacheColumnError(error) {
  const msg = (error?.message || '').toLowerCase();
  // Example: "Could not find the 'chunks' column of 'documents' in the schema cache"
  return msg.includes('schema cache') && msg.includes('could not find') && msg.includes('column');
}

function isIntegerSyntaxError(error) {
  const msg = (error?.message || '').toLowerCase();
  // Example: invalid input syntax for type integer: "e53803d604b4709a"
  return msg.includes('invalid input syntax for type integer');
}

function isMissingBucketError(error) {
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('bucket') && (msg.includes('not found') || msg.includes('does not exist'));
}

function isRlsViolationError(error) {
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('row-level security') || msg.includes('rls');
}

function sanitizeFilename(name) {
  const raw = String(name || '').trim() || 'document.pdf';
  // Keep it storage/path safe and reasonably readable.
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`;
}

function schemaHelp(table) {
  return (
    `Supabase table schema is missing required columns for '${table}'. ` +
    `Run backend/supabase/schema.sql in Supabase SQL Editor. ` +
    `If you just changed the table, reload the PostgREST schema cache in Supabase (Dashboard → Settings → API → "Reload schema") and try again.`
  );
}

function typeHelp(table) {
  return (
    `Supabase table '${table}' has incompatible column types for this app. ` +
    `This app expects documents.id to be TEXT (it uses a hash like "e53803d604b4709a"). ` +
    `Fix by either dropping and recreating the table with backend/supabase/schema.sql, ` +
    `or altering the column type in Supabase.`
  );
}

/**
 * In-memory store (assignment-friendly). In production you'd persist this.
 */

export function stableDocId(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export class DocumentStore {
  constructor({ supabaseUrl, supabaseServiceRoleKey, table = 'documents' }) {
    if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
    if (!supabaseServiceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

    // Common misconfig: using anon/publishable key on the backend.
    // That key is subject to RLS (including Storage) and will fail on uploads.
    if (String(supabaseServiceRoleKey).startsWith('sb_publishable_')) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is set to a publishable key. Use the Supabase service_role secret for backend writes/uploads.'
      );
    }

    /** @type {Map<string, any>} */
    this.docs = new Map();
    this.table = table;
    this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async init() {
    // Only validate that the table exists and is reachable.
    // Column mismatches are reported with actionable guidance during upsert.
    const { error } = await this.supabase.from(this.table).select('id').limit(1);
    if (error) throw new Error(`Supabase init failed: ${error.message}`);
  }

  async upsert(doc) {
    // Store only serializable parts; index is rebuilt at read time.
    // We try a few column layouts (snake_case, camelCase, minimal) to
    // tolerate existing Supabase tables created with different conventions.
    const attempts = [
      {
        id: doc.id,
        name: doc.name,
        created_at: doc.createdAt,
        num_pages: doc.numPages,
        pages: doc.pages,
        chunks: doc.chunks,
        scanned_likely: doc.scannedLikely,
        total_extracted_chars: doc.totalExtractedChars,
        non_empty_pages: doc.nonEmptyPages,
        summary: doc.summary ?? null,
        summary_updated_at: doc.summaryUpdatedAt ?? null,
      },
      {
        id: doc.id,
        name: doc.name,
        createdAt: doc.createdAt,
        numPages: doc.numPages,
        pages: doc.pages,
        chunks: doc.chunks,
        scannedLikely: doc.scannedLikely,
        totalExtractedChars: doc.totalExtractedChars,
        nonEmptyPages: doc.nonEmptyPages,
        summary: doc.summary ?? null,
        summaryUpdatedAt: doc.summaryUpdatedAt ?? null,
      },
      {
        id: doc.id,
        name: doc.name,
        pages: doc.pages,
        chunks: doc.chunks,
      },
    ];

    let lastError = null;
    for (const row of attempts) {
      const { error } = await this.supabase.from(this.table).upsert(row, { onConflict: 'id' });
      if (!error) {
        lastError = null;
        break;
      }
      lastError = error;
      if (!(isMissingColumnError(error) || isSchemaCacheColumnError(error))) break;
    }

    if (lastError && (isMissingColumnError(lastError) || isSchemaCacheColumnError(lastError))) {
      throw new Error(schemaHelp(this.table) + `\nOriginal error: ${lastError.message}`);
    }
    if (lastError && isIntegerSyntaxError(lastError)) {
      throw new Error(
        typeHelp(this.table) +
          `\nOriginal error: ${lastError.message}` +
          `\nSuggested SQL (if you have no important data):\n  drop table if exists public.${this.table};\n  -- then run backend/supabase/schema.sql and reload schema\n` +
          `\nSuggested SQL (if you want to keep rows):\n  alter table public.${this.table} alter column id type text using id::text;\n  -- then reload schema\n`
      );
    }
    if (lastError) throw new Error(`Supabase upsert failed: ${lastError.message}`);

    // Cache the in-memory version (with index) for fast subsequent reads.
    const index = buildTfidfIndex(doc.chunks || []);
    this.docs.set(doc.id, { ...doc, index });
  }

  /**
   * Upload the raw PDF into Supabase Storage.
   * Returns { bucket, path }.
   */
  async uploadPdfToStorage({
    docId,
    fileName,
    buffer,
    bucket,
    prefix = 'documents',
    contentType = 'application/pdf',
  }) {
    if (!bucket) throw new Error('Missing Supabase storage bucket name');
    if (!docId) throw new Error('Missing docId for storage upload');
    if (!buffer) throw new Error('Missing PDF buffer for storage upload');

    const safeName = sanitizeFilename(fileName);
    const path = `${prefix}/${docId}/${safeName}`;

    const { error } = await this.supabase.storage
      .from(bucket)
      .upload(path, buffer, { contentType, upsert: true, cacheControl: '3600' });

    if (error) {
      if (isMissingBucketError(error)) {
        throw new Error(
          `Supabase Storage bucket '${bucket}' not found. Create it in Supabase Dashboard (Storage → New bucket) ` +
            `or set SUPABASE_STORAGE_BUCKET to an existing bucket. Original error: ${error.message}`
        );
      }
      if (isRlsViolationError(error)) {
        throw new Error(
          'Supabase Storage upload failed due to RLS. This usually means the backend is using an anon/publishable key. ' +
            'Set SUPABASE_SERVICE_ROLE_KEY to the service_role secret (Project Settings → API) and restart the backend. ' +
            `Original error: ${error.message}`
        );
      }
      throw new Error(`Supabase Storage upload failed: ${error.message}`);
    }

    return { bucket, path };
  }

  /**
   * Best-effort: store storage metadata if columns exist.
   * Never throws on missing columns.
   */
  async tryUpdateStorageInfo(docId, { bucket, path, mime, bytes, updatedAt }) {
    if (!docId) return;
    const ts = updatedAt || new Date().toISOString();

    const attempts = [
      {
        storage_bucket: bucket,
        storage_path: path,
        storage_mime: mime,
        storage_bytes: typeof bytes === 'number' ? bytes : null,
        storage_updated_at: ts,
      },
      {
        storageBucket: bucket,
        storagePath: path,
        storageMime: mime,
        storageBytes: typeof bytes === 'number' ? bytes : null,
        storageUpdatedAt: ts,
      },
    ];

    for (const patch of attempts) {
      const { error } = await this.supabase.from(this.table).update(patch).eq('id', docId);
      if (!error) return;
      if (isMissingColumnError(error) || isSchemaCacheColumnError(error)) return;
      // Any other error: don't break uploads.
      return;
    }
  }

  async get(id) {
    const cached = this.docs.get(id);
    if (cached) return cached;

    const { data, error } = await this.supabase.from(this.table).select('*').eq('id', id).maybeSingle();

    if (error) throw new Error(`Supabase read failed: ${error.message}`);
    if (!data) return null;

    const doc = {
      id: data.id,
      name: data.name,
      createdAt: pick(data, ['created_at', 'createdAt', 'createdat'], null),
      numPages: pick(data, ['num_pages', 'numPages', 'numpages'], 0),
      pages: pick(data, ['pages'], []),
      chunks: pick(data, ['chunks'], []),
      scannedLikely: !!pick(data, ['scanned_likely', 'scannedLikely', 'scannedlikely'], false),
      totalExtractedChars: pick(data, ['total_extracted_chars', 'totalExtractedChars', 'totalextractedchars'], 0),
      nonEmptyPages: pick(data, ['non_empty_pages', 'nonEmptyPages', 'nonemptypages'], 0),
      summary: pick(data, ['summary'], null),
      summaryUpdatedAt: pick(data, ['summary_updated_at', 'summaryUpdatedAt', 'summaryupdatedat'], null),
      storageBucket: pick(data, ['storage_bucket', 'storageBucket'], null),
      storagePath: pick(data, ['storage_path', 'storagePath'], null),
      storageMime: pick(data, ['storage_mime', 'storageMime'], null),
      storageBytes: pick(data, ['storage_bytes', 'storageBytes'], null),
      storageUpdatedAt: pick(data, ['storage_updated_at', 'storageUpdatedAt'], null),
    };

    doc.index = buildTfidfIndex(doc.chunks);
    this.docs.set(id, doc);
    return doc;
  }

  async list() {
    const { data, error } = await this.supabase.from(this.table).select('*');

    if (error) throw new Error(`Supabase list failed: ${error.message}`);

    return (data || []).map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: pick(d, ['created_at', 'createdAt', 'createdat'], null),
      numPages: pick(d, ['num_pages', 'numPages', 'numpages'], 0),
      numChunks: Array.isArray(pick(d, ['chunks'], [])) ? pick(d, ['chunks'], []).length : 0,
      scannedLikely: !!pick(d, ['scanned_likely', 'scannedLikely', 'scannedlikely'], false),
      totalExtractedChars: pick(d, ['total_extracted_chars', 'totalExtractedChars', 'totalextractedchars'], 0),
      nonEmptyPages: pick(d, ['non_empty_pages', 'nonEmptyPages', 'nonemptypages'], 0),
    }));
  }
}
