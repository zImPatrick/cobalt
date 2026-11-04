// ISO BMFF box parsing and building (ISO/IEC 14496-12, section 4.2).

import { fourcc, Reader, UINT32_MAX, UnsupportedError, Writer, concatBytes } from "./bytes";

export interface Box {
    type: string;
    start: number; // offset of the size field
    headerSize: number; // 8, or 16 with a 64-bit size
    end: number; // offset just past the box
    extendsToEnd: boolean; // size field was 0: the box runs to the end of its container
}

export function payloadStart(box: Box): number {
    return box.start + box.headerSize;
}

/** Reads the boxes laid out back to back in [start, end). */
export function readBoxes(data: Uint8Array, start: number, end: number): Box[] {
    const boxes: Box[] = [];
    let pos = start;
    // Fewer than 8 bytes can't hold a box header. Some writers leave a few bytes of padding
    // (e.g. a 32-bit zero terminator in QuickTime udta), so stop rather than fail.
    while (end - pos >= 8) {
        const box = readBoxHeader(data.subarray(pos, Math.min(pos + 16, end)), pos, end);
        boxes.push(box);
        pos = box.end;
    }
    return boxes;
}

/**
 * Reads the header of the box at `pos` in a container ending at `end`. `header` holds the
 * bytes from `pos` on: at least 8, and 16 when there are that many before `end`.
 */
export function readBoxHeader(header: Uint8Array, pos: number, end: number): Box {
    const reader = new Reader(header);
    let size = reader.u32();
    const type = fourcc(header, 4);
    reader.skip(4);
    let headerSize = 8;
    let extendsToEnd = false;
    if (size === 1) {
        size = reader.u64();
        headerSize = 16;
    } else if (size === 0) {
        size = end - pos;
        extendsToEnd = true;
    }
    if (size < headerSize) {
        throw new UnsupportedError("The file is corrupt (invalid box size).");
    }
    if (size > end - pos) {
        throw new UnsupportedError("The file is truncated or corrupt.");
    }
    return { type, start: pos, headerSize, end: pos + size, extendsToEnd };
}

export function childBoxes(data: Uint8Array, parent: Box): Box[] {
    return readBoxes(data, payloadStart(parent), parent.end);
}

export function findChild(data: Uint8Array, parent: Box, type: string): Box | undefined {
    return childBoxes(data, parent).find((box) => box.type === type);
}

export function requireChild(data: Uint8Array, parent: Box, type: string): Box {
    const box = findChild(data, parent, type);
    if (!box) {
        throw new UnsupportedError(`The file is missing a required '${type}' box.`);
    }
    return box;
}

/** A reader over a full box's body, positioned after its version and flags. */
export function readFullBox(data: Uint8Array, box: Box): { version: number; flags: number; reader: Reader } {
    const reader = new Reader(data, payloadStart(box), box.end);
    const version = reader.u8();
    const flags = reader.u24();
    return { version, flags, reader };
}

export function makeBox(type: string, payload: Uint8Array): Uint8Array {
    const writer = new Writer();
    if (payload.length + 8 <= UINT32_MAX) {
        writer.u32(payload.length + 8).ascii(type);
    } else {
        writer.u32(1).ascii(type).u64(payload.length + 16);
    }
    return concatBytes([writer.toBytes(), payload]);
}

export function makeFullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const header = new Writer().u8(version).u24(flags).toBytes();
    return makeBox(type, concatBytes([header, body]));
}

/** A `free` box of exactly `size` bytes (at least 8), used to fill slack. */
export function makeFreeBox(size: number): Uint8Array {
    if (size < 8 || size > UINT32_MAX) throw new RangeError(`cannot make a free box of ${size} bytes`);
    return makeBox("free", new Uint8Array(size - 8));
}
