import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertNonSensitive, isWithin } from './access';
import { requireItem, StateStore, validId, type StoredAttachment } from './storage';
import type { Attachment } from '../shared/types';
import type { ModelImage } from '../shared/agent';

const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
type ImageType = { mimeType: string; extension: string; width?: number; height?: number };

export function detectImage(buffer: Buffer): ImageType {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', extension: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return { mimeType: 'image/gif', extension: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const type: ImageType = { mimeType: 'image/webp', extension: 'webp' };
    if (buffer.length >= 30 && buffer.toString('ascii', 12, 16) === 'VP8X') { type.width = 1 + buffer.readUIntLE(24, 3); type.height = 1 + buffer.readUIntLE(27, 3); }
    return type;
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const type: ImageType = { mimeType: 'image/jpeg', extension: 'jpg' };
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        type.height = buffer.readUInt16BE(offset + 5); type.width = buffer.readUInt16BE(offset + 7); break;
      }
      offset += length + 2;
    }
    return type;
  }
  throw new Error('Supported image formats: PNG, JPEG, GIF and WebP. File content must match its format.');
}

export class AttachmentService {
  constructor(private store: StateStore) {}

  /** `reuse` (inspect_image) returns an existing attachment with the same canonical source and SHA-256 instead of copying again. */
  async import(paths: string[], options: { reuse?: boolean } = {}): Promise<Attachment[]> {
    if (!Array.isArray(paths)) throw new Error('Choose image files.');
    const directory = path.join(this.store.directory, 'attachments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attachments: Attachment[] = [];
    for (const source of paths) {
      if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Image source must be an absolute path.');
      assertNonSensitive(source);
      const canonical = await realpath(source);
      assertNonSensitive(canonical);
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      let buffer: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_IMAGE_SIZE) throw new Error('Each image must be a regular file up to 25 MiB. There is no image count limit.');
        buffer = await handle.readFile();
      } finally { await handle.close(); }
      const type = detectImage(buffer);
      if (type.width !== undefined && type.height !== undefined && (!type.width || !type.height || type.width * type.height > 100_000_000)) throw new Error('Image dimensions are invalid or exceed 100 megapixels.');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const match = (stored: StoredAttachment) => stored.source === canonical && stored.sha256 === sha256 && stored.size === buffer.length && stored.mimeType === type.mimeType;
      if (options.reuse) {
        const existing = await this.reusable((await this.store.read()).attachments.find(match));
        if (existing) { attachments.push(existing); continue; }
      }
      const id = randomUUID();
      const file = path.join(directory, `${id}.${type.extension}`);
      await writeFile(file, buffer, { mode: 0o600, flag: 'wx' });
      const attachment: Attachment = { id, name: path.basename(source), mimeType: type.mimeType, size: buffer.length, createdAt: new Date().toISOString(), width: type.width, height: type.height };
      // Re-check inside the commit: a concurrent identical import keeps the first copy.
      const winner = await this.store.mutate(state => {
        const existing = options.reuse ? state.attachments.find(match) : undefined;
        if (existing) return existing.id;
        state.attachments.push({ ...attachment, file, source: canonical, sha256 }); return id;
      });
      if (winner !== id) { await rm(file, { force: true }); attachments.push(await this.get(winner)); }
      else attachments.push(attachment);
    }
    return attachments;
  }

  private async reusable(stored?: StoredAttachment): Promise<Attachment | undefined> {
    if (!stored) return;
    try { if ((await stat(await this.resolve(stored.id))).size !== stored.size) return; } catch { return; }
    return this.get(stored.id);
  }

  async get(id: string): Promise<Attachment> {
    const { file: _file, source: _source, sha256: _sha256, ...attachment } = requireItem((await this.store.read()).attachments, validId(id), 'Attachment');
    return attachment;
  }

  async resolve(id: string): Promise<string> {
    const stored = requireItem((await this.store.read()).attachments, validId(id), 'Attachment');
    const canonical = await realpath(stored.file);
    const directory = await realpath(path.join(this.store.directory, 'attachments'));
    if (!isWithin(directory, canonical)) throw new Error('Attachment path is invalid.');
    return canonical;
  }

  async image(id: string): Promise<ModelImage> {
    const attachment = await this.get(id);
    const file = await this.resolve(id);
    const buffer = await readFile(file);
    if (buffer.length > MAX_IMAGE_SIZE || detectImage(buffer).mimeType !== attachment.mimeType) throw new Error('Stored image failed validation.');
    return { mimeType: attachment.mimeType, base64: buffer.toString('base64') };
  }
}
