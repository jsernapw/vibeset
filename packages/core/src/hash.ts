import { createHash } from 'node:crypto';

/** sha256 hex digest of a string, used as the primary key for `ComponentSnapshot`. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
