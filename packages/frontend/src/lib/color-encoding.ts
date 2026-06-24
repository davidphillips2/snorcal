/**
 * Base64 ↔ Uint8Array codec for face-color blobs.
 *
 * Face colors are stored as 1 byte/face (extruder index 1..15). Blobs are
 * transported as base64 strings over JSON. Large blobs are chunked to stay
 * under V8's argument-count limit on `String.fromCharCode(...slice)`.
 */

const CHUNK = 8192;

export function encodeFaceColors(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

export function decodeFaceColors(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
