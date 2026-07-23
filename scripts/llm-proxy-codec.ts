import type { IncomingHttpHeaders } from "node:http";
import zlib from "node:zlib";

/** Return one HTTP header as a comma-joined string. */
export function headerString(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  return "";
}

/** Decode a supported HTTP content encoding without mutating the source buffer. */
export function decompressBody(buffer: Buffer, headers: IncomingHttpHeaders): Buffer {
  const encoding = headerString(headers, "content-encoding").toLowerCase();
  if (encoding.length === 0) return buffer;

  try {
    if (encoding.includes("gzip")) return Buffer.from(zlib.gunzipSync(buffer));
    if (encoding.includes("br")) return Buffer.from(zlib.brotliDecompressSync(buffer));
    if (encoding.includes("zstd")) return Buffer.from(zlib.zstdDecompressSync(buffer));
    if (encoding.includes("deflate")) return Buffer.from(zlib.inflateSync(buffer));
  } catch {
    return buffer;
  }
  return buffer;
}

/** Decode and parse an HTTP JSON body while leaving forwarding bytes untouched. */
export function parseJsonHttpBody(
  buffer: Buffer,
  headers: IncomingHttpHeaders
): Record<string, unknown> {
  return JSON.parse(decompressBody(buffer, headers).toString("utf8")) as Record<string, unknown>;
}
