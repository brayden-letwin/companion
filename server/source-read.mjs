import { createHash } from 'node:crypto';

const MAX_BYTES = 48 * 1024;
const FILE_BYTES = 250000;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const high = (text, index) => { const code = text.charCodeAt(index); return code >= 0xd800 && code <= 0xdbff; };
const low = (text, index) => { const code = text.charCodeAt(index); return code >= 0xdc00 && code <= 0xdfff; };
const boundary = (text, index) => index > 0 && index < text.length && high(text, index - 1) && low(text, index) ? index - 1 : index;

/** Transport validation only. The builder retains its existing path allowlist. */
export function validateSourceReadOptions(value) {
  if (!object(value) || Object.keys(value).some(key => !['path', 'expectedHash', 'offset', 'limit'].includes(key))
    || typeof value.path !== 'string' || !value.path || value.path.length > 200) throw fail('invalid_source_query', 'Choose one exact path from the source inventory.');
  const offset = value.offset === undefined ? 0 : value.offset, limit = value.limit === undefined ? 12000 : value.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > FILE_BYTES || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw fail('invalid_source_query', 'Use a source offset from 0 to 250000 and a limit from 1 to 12000.');
  if (value.expectedHash !== undefined && (typeof value.expectedHash !== 'string' || !HASH.test(value.expectedHash)) || offset > 0 && value.expectedHash === undefined) throw fail('invalid_source_query', 'Continuation pages require the exact source SHA-256 hash.');
  return { path: value.path, offset, limit, ...(value.expectedHash !== undefined ? { expectedHash: value.expectedHash } : {}) };
}

/** Format already-authorized captured source. This module has no filesystem access. */
export function formatSourceFile(file, options) {
  const query = validateSourceReadOptions(options);
  if (!object(file) || file.path !== query.path || typeof file.content !== 'string' || typeof file.hash !== 'string' || !HASH.test(file.hash)) throw fail('invalid_source_snapshot', 'The captured source file is invalid.', 500);
  const bytes = Buffer.from(file.content, 'utf8');
  if (bytes.length > FILE_BYTES || bytes.includes(0) || bytes.toString('utf8') !== file.content || file.bytes !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== file.hash) throw fail('invalid_source_snapshot', 'The captured source file is invalid.', 500);
  if (query.expectedHash !== undefined && query.expectedHash !== file.hash) throw fail('source_conflict', 'The source file changed. Read its current first page before continuing.', 409);
  const text = file.content, offset = query.offset;
  if (offset > text.length || boundary(text, offset) !== offset) throw fail('invalid_source_query', 'The source offset is past the end or splits a Unicode character.');
  let end = boundary(text, Math.min(text.length, offset + query.limit));
  if (offset < text.length && end === offset) throw fail('invalid_source_query', 'Use a limit of at least two characters for this Unicode source character.');
  const page = stop => ({ path: file.path, hash: file.hash, content: text.slice(offset, stop), offset, nextOffset: stop < text.length ? stop : null, hasMore: stop < text.length, characterLength: text.length, byteLength: bytes.length, sourceTrust: 'untrusted_source' });
  let result = page(end);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
    let minimum = offset, maximum = end;
    while (minimum < maximum) {
      const candidate = Math.ceil((minimum + maximum) / 2), stop = boundary(text, candidate);
      if (Buffer.byteLength(JSON.stringify(page(stop))) <= MAX_BYTES) minimum = candidate;
      else maximum = candidate - 1;
    }
    end = boundary(text, minimum); result = page(end);
  }
  if (offset < text.length && end <= offset || Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw fail('source_result_limit', 'This source page exceeds its response budget.', 413);
  return result;
}
