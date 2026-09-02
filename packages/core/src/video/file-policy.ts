const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  '.mp4': bytes => hasAscii(bytes, 4, 'ftyp'),
  '.m4v': bytes => hasAscii(bytes, 4, 'ftyp'),
  '.mov': bytes => hasAscii(bytes, 4, 'ftyp'),
  '.webm': bytes => hasBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
  '.mkv': bytes => hasBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
  '.avi': bytes => hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'AVI '),
};

export const SUPPORTED_VIDEO_EXTENSIONS = Object.keys(SIGNATURES);

/** Check a filename extension and a small header sample. */
export function hasSupportedVideoSignature(filename: string, bytes: Uint8Array): boolean {
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return SIGNATURES[extension]?.(bytes) === true;
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function hasBytes(bytes: Uint8Array, expected: number[]): boolean {
  return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
}
