/**
 * The slice of Node's Buffer Orbit uses: byte lengths, utf-8/base64/hex conversions and
 * zero-filled allocation. Vendored rather than installed, since the worker needs only this much.
 */
type Encoding = "utf8" | "utf-8" | "base64" | "hex" | "latin1" | "binary";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string, encoding: Encoding = "utf8"): Uint8Array {
  switch (encoding) {
    case "base64": {
      const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }
    case "hex": {
      const pairs = text.match(/[0-9a-fA-F]{2}/g) ?? [];
      return Uint8Array.from(pairs, (pair) => parseInt(pair, 16));
    }
    case "latin1":
    case "binary":
      return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    default:
      return encoder.encode(text);
  }
}

/** What Buffer.from and friends return: bytes that print themselves in Node's encodings. */
export class Bytes extends Uint8Array {
  override toString(encoding: Encoding = "utf8"): string {
    switch (encoding) {
      case "base64": {
        let binary = "";
        for (const byte of this) binary += String.fromCharCode(byte);
        return btoa(binary);
      }
      case "hex":
        return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
      case "latin1":
      case "binary":
        return String.fromCharCode(...this);
      default:
        return decoder.decode(this);
    }
  }

  equals(other: Uint8Array): boolean {
    return this.length === other.length && this.every((b, i) => b === other[i]);
  }
}

const wrap = (bytes: Uint8Array): Bytes =>
  new Bytes(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);

export const Buffer = {
  from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: Encoding): Bytes {
    if (typeof value === "string") return wrap(encode(value, encoding));
    if (value instanceof ArrayBuffer) return wrap(new Uint8Array(value));
    return wrap(Uint8Array.from(value));
  },

  alloc(size: number): Bytes {
    return new Bytes(size);
  },

  byteLength(value: string | ArrayLike<number>, encoding?: Encoding): number {
    return typeof value === "string" ? encode(value, encoding).length : value.length;
  },

  isBuffer(value: unknown): value is Bytes {
    return value instanceof Bytes;
  },

  concat(chunks: Uint8Array[]): Bytes {
    const out = new Bytes(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  },
};

export default { Buffer };
