'use strict';

/**
 * Upload pipeline (plan step 21).
 *
 * The previous implementation trusted the client. `file.mimetype` is parsed out
 * of the multipart `Content-Type` header, which the caller fully controls, so
 * `Content-Type: image/png` over `<script>alert(1)</script>` was stored happily
 * under a `.png` name. The only thing standing between PenPal and a same-origin
 * stored-XSS / arbitrary-byte-storage primitive was the client's own honesty.
 *
 * This module replaces that with four independent gates, each of which must pass:
 *
 *   1. Magic-byte sniffing on the real bytes on disk. The client header is
 *      ignored entirely — it is not even consulted.
 *   2. A hard pixel ceiling, so a 10MB zip-bomb ("decompression bomb") cannot be
 *      expanded into gigabytes of pixels in RAM.
 *   3. A full re-encode through sharp. Nothing from the source file survives by
 *      construction: only pixel data crosses the boundary, so EXIF, GPS, ICC
 *      profiles, XMP and any payload appended after the final `IEND`/EOI are all
 *      dropped.
 *   4. A post-write assertion that the bytes now on disk carry no metadata
 *      chunks at all. This is the check that matters most for a private
 *      correspondence app: a phone photo's EXIF block routinely contains the
 *      sender's home address and live GPS coordinates, which must never become
 *      visible to the recipient.
 *
 * Fail-closed throughout: anything that throws leaves nothing stored. Files are
 * only written after every check has passed, and a partially-written pair is
 * unlinked on failure.
 */

const fsp = require('fs/promises');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

/** Hard ceiling on the compressed upload, enforced by multer before we read it. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Hard ceiling on decoded pixels per axis and in total. sharp enforces the total
 * (via limitInputPixels) while decoding, so a highly-compressible image cannot be
 * used to exhaust memory.
 */
const MAX_DIMENSION = 8000;

/** Longest edge of the generated thumbnail. */
const THUMB_MAX = 400;

const SNIFF_BYTES = 32;

/** Formats we accept, keyed by what our own sniffer reports — never by the client. */
const FORMATS = Object.freeze({
  jpeg: Object.freeze({ ext: '.jpg', encode: (p) => p.jpeg({ quality: 85, mozjpeg: true }) }),
  png: Object.freeze({ ext: '.png', encode: (p) => p.png({ compressionLevel: 9 }) }),
  gif: Object.freeze({ ext: '.gif', encode: (p) => p.gif() }),
  webp: Object.freeze({ ext: '.webp', encode: (p) => p.webp({ quality: 85 }) }),
});

/** Rejection with an HTTP status. Anything thrown that is not one of these is a 500. */
class UploadRejected extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadRejected';
    this.status = status;
    this.expose = true;
  }
}

const reject = (msg, status) => {
  throw new UploadRejected(msg, status);
};

/**
 * libvips reports failures as multi-line diagnostics full of internal detail.
 * That is fine for a log, not for a response body: keep the first line only.
 */
const brief = (err) => String(err && err.message ? err.message : 'unknown error').split('\n')[0].trim();

/* ------------------------------------------------------------------ *
 * 1. Magic bytes
 * ------------------------------------------------------------------ */

const startsWith = (buf, sig, offset = 0) => {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
};

const ascii = (buf, start, len) => buf.toString('latin1', start, start + len);

/**
 * Determine the real format from the leading bytes of the file.
 *
 * The client-declared MIME type is deliberately not a parameter here: it is
 * attacker-controlled. Returns a key of FORMATS, or throws.
 *
 * @param {Buffer} head first bytes of the file (SNIFF_BYTES is enough)
 * @returns {'jpeg'|'png'|'gif'|'webp'}
 */
function sniffFormat(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) {
    reject('Uploaded file is too small to be a valid image');
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  // JPEG: FF D8 FF
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  // GIF87a / GIF89a
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  // WEBP: RIFF....WEBP — the size field is untrusted, so only the two tags matter.
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && ascii(head, 8, 4) === 'WEBP') return 'webp';

  reject('File content is not a supported image (allowed: JPEG, PNG, WebP, GIF)');
}

/* ------------------------------------------------------------------ *
 * 2. Metadata scanners — used to assert the *output* is clean
 * ------------------------------------------------------------------ */

/** Walk PNG chunk headers and return the set of chunk types present. */
function pngChunkTypes(buf) {
  const types = new Set();
  let offset = 8; // skip signature
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = ascii(buf, offset + 4, 4);
    types.add(type);
    // A corrupt length must not send us into an infinite loop or a huge alloc.
    if (length > buf.length || length < 0) break;
    offset += 12 + length;
  }
  return types;
}

/** Walk JPEG segments; returns true if any segment carries EXIF/XMP/ICC. */
function jpegHasMetadataSegment(buf) {
  let offset = 2; // skip SOI
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return false; // not a segment we can reason about
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return false; // SOS / EOI: entropy data follows
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return false;
    // APP1 = EXIF / XMP, APP2 = ICC
    if (marker === 0xe1 || marker === 0xe2) {
      const payload = ascii(buf, offset + 4, Math.min(length - 2, 29));
      if (payload.startsWith('Exif')) return true;
      if (payload.startsWith('http://ns.adobe.com/xap/1.0/')) return true;
      if (marker === 0xe2) return true;
    }
    offset += 2 + length;
  }
  return false;
}

/** Walk RIFF chunk headers (WebP) and report whether metadata chunks are present. */
function webpHasMetadataChunk(buf) {
  if (ascii(buf, 0, 4) !== 'RIFF') return true;
  let offset = 12; // 'RIFF' + size + 'WEBP'
  while (offset + 8 <= buf.length) {
    const type = ascii(buf, offset, 4);
    if (type === 'EXIF' || type === 'XMP ' || type === 'ICCP') return true;
    const length = buf.readUInt32LE(offset + 4);
    if (length > buf.length) break;
    offset += 8 + length + (length % 2); // chunks are word-aligned
  }
  return false;
}

/**
 * Assert that the encoded buffer really is a valid image of the expected format
 * and carries no metadata. `assertNoMetadata` is not a formality: it is the
 * control that stops a sender's GPS coordinates from being handed to their pen
 * pal, and the control that stops a payload appended after the image data from
 * surviving the round trip.
 */
async function assertSanitised(buffer, format) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
  } catch (err) {
    reject(`Re-encoded image failed validation: ${brief(err)}`);
  }
  if (meta.format !== format) reject('Re-encoded image is not in the expected format');
  if (meta.exif && meta.exif.length > 0) reject('Re-encoded image still contains an EXIF block');
  if (meta.icc && meta.icc.length > 0) reject('Re-encoded image still contains an ICC profile');

  if (format === 'png') {
    const types = pngChunkTypes(buffer);
    for (const banned of ['eXIf', 'iCCP', 'tEXt', 'iTXt', 'zTXt']) {
      if (types.has(banned)) reject(`Re-encoded PNG still contains a ${banned} chunk`);
    }
  } else if (format === 'jpeg') {
    if (jpegHasMetadataSegment(buffer)) reject('Re-encoded JPEG still contains an EXIF/XMP/ICC segment');
  } else if (format === 'webp') {
    if (webpHasMetadataChunk(buffer)) reject('Re-encoded WebP still contains a metadata chunk');
  }

  return meta;
}

/* ------------------------------------------------------------------ *
 * 3. The pipeline
 * ------------------------------------------------------------------ */

/**
 * Validate, sanitise and store an upload.
 *
 * @param {Buffer} buffer raw uploaded bytes (multer memory storage, capped above)
 * @param {string} uploadsDir destination directory
 * @returns {Promise<{filename:string, thumbFilename:string, filepath:string,
 *   thumbFilepath:string, width:number, height:number, format:string, bytes:number}>}
 */
async function processUpload(buffer, uploadsDir) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) reject('No file uploaded');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    reject(`Image exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`, 413);
  }

  // Gate 1: what are these bytes, really?
  const format = sniffFormat(buffer.subarray(0, SNIFF_BYTES));
  const spec = FORMATS[format];

  // Gate 2: dimensions, before we decode anything into memory.
  let source;
  try {
    // limitInputPixels makes sharp refuse oversized images during decode, and
    // animated:false flattens GIF/WebP animations to their first frame, which
    // bounds decode cost. `rotate()` with no argument applies the EXIF
    // orientation and then drops the EXIF block entirely.
    source = sharp(buffer, {
      limitInputPixels: MAX_DIMENSION * MAX_DIMENSION,
      animated: false,
      failOn: 'warning',
    }).rotate();
    source = await source.metadata();
  } catch (err) {
    reject(`Image could not be decoded: ${brief(err)}`);
  }

  if (!source.width || !source.height) reject('Image has no usable dimensions');
  if (source.width > MAX_DIMENSION || source.height > MAX_DIMENSION) {
    reject(`Image exceeds the ${MAX_DIMENSION}x${MAX_DIMENSION} pixel limit`);
  }

  // Gate 3: re-encode. Only decoded pixels are carried over, so nothing in the
  // source container survives — including anything appended after the image
  // data, which a magic-byte check alone cannot catch.
  //
  // `withMetadata()` is deliberately never called: it is sharp's opt-in for
  // carrying EXIF/ICC/XMP across, and calling it is precisely the bug this gate
  // exists to prevent. `rotate()` applies the EXIF orientation before dropping
  // the block, so photos are not left sideways once it is gone.
  const decode = () =>
    sharp(buffer, {
      limitInputPixels: MAX_DIMENSION * MAX_DIMENSION,
      animated: false,
      failOn: 'warning',
    }).rotate();

  let full;
  let thumb;
  try {
    full = await spec.encode(decode()).toBuffer();
  } catch (err) {
    reject(`Image could not be re-encoded: ${brief(err)}`);
  }

  try {
    thumb = await spec
      .encode(decode().resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true }))
      .toBuffer();
  } catch (err) {
    reject(`Thumbnail could not be generated: ${brief(err)}`);
  }

  // Gate 4: verify the bytes we are about to serve, not the bytes we were given.
  const outMeta = await assertSanitised(full, format);
  await assertSanitised(thumb, format);

  // Only now does anything touch the disk.
  const base = uuidv4();
  const filename = `${base}${spec.ext}`;
  const thumbFilename = `${base}_thumb${spec.ext}`;
  const fullPath = path.join(uploadsDir, filename);
  const thumbPath = path.join(uploadsDir, thumbFilename);

  try {
    await fsp.writeFile(fullPath, full, { flag: 'wx', mode: 0o600 });
    try {
      await fsp.writeFile(thumbPath, thumb, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      await fsp.rm(fullPath, { force: true }); // never leave half an upload behind
      throw err;
    }
  } catch (err) {
    reject(`Image could not be stored: ${brief(err)}`, 500);
  }

  return {
    filename,
    thumbFilename,
    filepath: `/uploads/${filename}`,
    thumbFilepath: `/uploads/${thumbFilename}`,
    width: outMeta.width,
    height: outMeta.height,
    format,
    bytes: full.length,
  };
}

/**
 * Thumbnail URL for an already-stored upload. Derived from the stored filename
 * rather than a second DB column so the `photos` schema (and every existing
 * consumer of `filepath`) stays exactly as it was.
 */
const thumbUrlFor = (url) => url.replace(/(\.[a-z0-9]+)$/i, '_thumb$1');

/**
 * Multer middleware. Memory storage, deliberately: the file must be sniffed and
 * re-encoded before anything is persisted, so it never exists on disk in its
 * original, attacker-controlled form.
 */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  // No fileFilter. The old one compared `file.mimetype` against an allowlist,
  // which reads like a type check but is only an assertion by the sender about
  // their own file. The sniff below is the actual gate, and it works for every
  // caller regardless of what Content-Type they claim.
});

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_DIMENSION,
  THUMB_MAX,
  FORMATS,
  UploadRejected,
  photoUpload,
  sniffFormat,
  processUpload,
  thumbUrlFor,
};
