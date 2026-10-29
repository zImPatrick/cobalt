// Bounds-checked big-endian reading and writing. MP4 is big-endian throughout.

/**
 * Thrown for input we can't read or can't safely fix. The public API turns it into
 * `{ status: 'unsupported', reason }`, so the message is shown to users.
 */
export class UnsupportedError extends Error {}

export const UINT32_MAX = 0xffffffff;

export function fourcc(data: Uint8Array, offset: number): string {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

export class Reader {
    readonly data: Uint8Array;
    readonly end: number;
    pos: number;
    private view: DataView;

    constructor(data: Uint8Array, start = 0, end = data.length) {
        this.data = data;
        this.pos = start;
        this.end = end;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    get remaining(): number {
        return this.end - this.pos;
    }

    private take(length: number): number {
        if (length > this.remaining) {
            throw new UnsupportedError("The file is truncated or corrupt.");
        }
        const at = this.pos;
        this.pos += length;
        return at;
    }

    skip(length: number): void {
        this.take(length);
    }

    u8(): number {
        return this.view.getUint8(this.take(1));
    }

    u16(): number {
        return this.view.getUint16(this.take(2));
    }

    i16(): number {
        return this.view.getInt16(this.take(2));
    }

    u24(): number {
        const at = this.take(3);
        return (this.view.getUint8(at) << 16) | this.view.getUint16(at + 1);
    }

    u32(): number {
        return this.view.getUint32(this.take(4));
    }

    i32(): number {
        return this.view.getInt32(this.take(4));
    }

    u64(): number {
        return toSafeNumber(this.view.getBigUint64(this.take(8)));
    }

    i64(): number {
        return toSafeNumber(this.view.getBigInt64(this.take(8)));
    }

    bytes(length: number): Uint8Array {
        const at = this.take(length);
        return this.data.subarray(at, at + length);
    }
}

function toSafeNumber(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new UnsupportedError("The file contains a value too large to handle.");
    }
    return Number(value);
}

/** A growable byte buffer. Throws on out-of-range values, which would be a bug in our code. */
export class Writer {
    private buffer = new Uint8Array(256);
    private view = new DataView(this.buffer.buffer);
    length = 0;

    /** Grows the buffer if needed and returns the offset to write `extra` bytes at. */
    private reserve(extra: number): number {
        const needed = this.length + extra;
        if (needed > this.buffer.length) {
            let size = this.buffer.length * 2;
            while (size < needed) size *= 2;
            const next = new Uint8Array(size);
            next.set(this.buffer.subarray(0, this.length));
            this.buffer = next;
            this.view = new DataView(next.buffer);
        }
        const at = this.length;
        this.length = needed;
        return at;
    }

    u8(value: number): this {
        checkRange(value, 0, 0xff);
        const at = this.reserve(1);
        this.view.setUint8(at, value);
        return this;
    }

    u16(value: number): this {
        checkRange(value, 0, 0xffff);
        const at = this.reserve(2);
        this.view.setUint16(at, value);
        return this;
    }

    i16(value: number): this {
        checkRange(value, -0x8000, 0x7fff);
        const at = this.reserve(2);
        this.view.setInt16(at, value);
        return this;
    }

    u24(value: number): this {
        checkRange(value, 0, 0xffffff);
        const at = this.reserve(3);
        this.view.setUint8(at, value >>> 16);
        this.view.setUint16(at + 1, value & 0xffff);
        return this;
    }

    u32(value: number): this {
        checkRange(value, 0, UINT32_MAX);
        const at = this.reserve(4);
        this.view.setUint32(at, value);
        return this;
    }

    i32(value: number): this {
        checkRange(value, -0x80000000, 0x7fffffff);
        const at = this.reserve(4);
        this.view.setInt32(at, value);
        return this;
    }

    u64(value: number): this {
        checkRange(value, 0, Number.MAX_SAFE_INTEGER);
        const at = this.reserve(8);
        this.view.setBigUint64(at, BigInt(value));
        return this;
    }

    i64(value: number): this {
        checkRange(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        const at = this.reserve(8);
        this.view.setBigInt64(at, BigInt(value));
        return this;
    }

    ascii(text: string): this {
        for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i));
        return this;
    }

    bytes(bytes: Uint8Array): this {
        const at = this.reserve(bytes.length);
        this.buffer.set(bytes, at);
        return this;
    }

    toBytes(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}

function checkRange(value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`value ${value} does not fit the field`);
    }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
