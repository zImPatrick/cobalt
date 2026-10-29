// Reading and writing the timing boxes we rewrite: stts, ctts, cslg, elst, mvhd/mdhd, tkhd.
// Field layouts follow ISO/IEC 14496-12. "Version 1" variants widen times to 64 bits.

import { makeFullBox, readFullBox, type Box } from "./boxes";
import { UINT32_MAX, UnsupportedError, Writer } from "./bytes";

// More samples than this in one track is not a real file (a day of 120 fps video is ~10M).
const MAX_SAMPLES = 20_000_000;

/** A run of `count` consecutive samples, each lasting `delta` ticks (one stts entry). */
export interface DurationRun {
    count: number;
    delta: number;
}

/** A run of `count` consecutive samples sharing a composition offset (one ctts entry). */
export interface OffsetRun {
    count: number;
    offset: number;
}

export function readStts(data: Uint8Array, box: Box): DurationRun[] {
    const { reader } = readFullBox(data, box);
    const entryCount = reader.u32();
    if (entryCount * 8 > reader.remaining) throw new UnsupportedError("The stts box is corrupt.");
    const runs: DurationRun[] = [];
    for (let i = 0; i < entryCount; i++) {
        runs.push({ count: reader.u32(), delta: reader.u32() });
    }
    return runs;
}

export function makeStts(runs: DurationRun[]): Uint8Array {
    const body = new Writer().u32(runs.length);
    for (const run of runs) body.u32(run.count).u32(run.delta);
    return makeFullBox("stts", 0, 0, body.toBytes());
}

export function readCtts(data: Uint8Array, box: Box): { version: number; runs: OffsetRun[] } {
    const { version, reader } = readFullBox(data, box);
    const entryCount = reader.u32();
    if (entryCount * 8 > reader.remaining) throw new UnsupportedError("The ctts box is corrupt.");
    const runs: OffsetRun[] = [];
    for (let i = 0; i < entryCount; i++) {
        // Version 0 offsets are unsigned and version 1 signed, but some muxers wrote negative
        // offsets into version 0 boxes. Reading both as signed matches what players (and
        // ffmpeg) do; an unsigned offset above 2^31 ticks is never meant literally.
        runs.push({ count: reader.u32(), offset: reader.i32() });
    }
    return { version, runs };
}

export function makeCtts(version: number, runs: OffsetRun[]): Uint8Array {
    const body = new Writer().u32(runs.length);
    for (const run of runs) {
        body.u32(run.count);
        if (version === 0) body.u32(run.offset);
        else body.i32(run.offset);
    }
    return makeFullBox("ctts", version, 0, body.toBytes());
}

/** Composition shift box: summarises the ctts offsets. Only present alongside signed ctts. */
export interface CompositionShift {
    compositionToDtsShift: number;
    leastDecodeToDisplayDelta: number;
    greatestDecodeToDisplayDelta: number;
    compositionStartTime: number;
    compositionEndTime: number;
}

export function makeCslg(version: number, shift: CompositionShift): Uint8Array {
    const values = [
        shift.compositionToDtsShift,
        shift.leastDecodeToDisplayDelta,
        shift.greatestDecodeToDisplayDelta,
        shift.compositionStartTime,
        shift.compositionEndTime
    ];
    const fits = values.every((value) => value >= -0x80000000 && value <= 0x7fffffff);
    const useVersion = version === 1 || !fits ? 1 : 0;
    const body = new Writer();
    for (const value of values) {
        if (useVersion === 1) body.i64(value);
        else body.i32(value);
    }
    return makeFullBox("cslg", useVersion, 0, body.toBytes());
}

/** Expands run-length durations or offsets into one value per sample. */
export function expandRuns(runs: { count: number }[], valueOf: (index: number) => number, sampleCount: number): Float64Array {
    if (sampleCount > MAX_SAMPLES) throw new UnsupportedError("The file has too many samples.");
    if (totalCount(runs) !== sampleCount) {
        throw new UnsupportedError("The sample tables disagree on the number of samples.");
    }
    const values = new Float64Array(sampleCount);
    let at = 0;
    runs.forEach((run, index) => {
        values.fill(valueOf(index), at, at + run.count);
        at += run.count;
    });
    return values;
}

export function expandDurations(runs: DurationRun[], sampleCount: number): Float64Array {
    return expandRuns(runs, (i) => runs[i].delta, sampleCount);
}

export function expandOffsets(runs: OffsetRun[], sampleCount: number): Float64Array {
    return expandRuns(runs, (i) => runs[i].offset, sampleCount);
}

export function totalCount(runs: { count: number }[]): number {
    let total = 0;
    for (const run of runs) total += run.count;
    return total;
}

export function totalDuration(runs: DurationRun[]): number {
    let total = 0;
    for (const run of runs) total += run.count * run.delta;
    return total;
}

/** Run-length encodes per-sample values (the inverse of expandRuns). */
export function toRuns(values: ArrayLike<number>): { count: number; value: number }[] {
    const runs: { count: number; value: number }[] = [];
    for (let i = 0; i < values.length; i++) {
        const last = runs[runs.length - 1];
        if (last && last.value === values[i]) last.count++;
        else runs.push({ count: 1, value: values[i] });
    }
    return runs;
}

export interface EditEntry {
    segmentDuration: number; // movie timescale
    mediaTime: number; // media timescale; -1 marks an empty edit
    rateInteger: number;
    rateFraction: number;
}

export function readElst(data: Uint8Array, box: Box): { version: number; flags: number; entries: EditEntry[] } {
    const { version, flags, reader } = readFullBox(data, box);
    const entryCount = reader.u32();
    if (entryCount * (version === 1 ? 20 : 12) > reader.remaining) {
        throw new UnsupportedError("The edit list is corrupt.");
    }
    const entries: EditEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
        const segmentDuration = version === 1 ? reader.u64() : reader.u32();
        const mediaTime = version === 1 ? reader.i64() : reader.i32();
        entries.push({ segmentDuration, mediaTime, rateInteger: reader.i16(), rateFraction: reader.i16() });
    }
    return { version, flags, entries };
}

export function makeElst(version: number, flags: number, entries: EditEntry[]): Uint8Array {
    const fits = entries.every((e) => e.segmentDuration <= UINT32_MAX && e.mediaTime <= 0x7fffffff);
    const useVersion = version === 1 || !fits ? 1 : 0;
    const body = new Writer().u32(entries.length);
    for (const entry of entries) {
        if (useVersion === 1) body.u64(entry.segmentDuration).i64(entry.mediaTime);
        else body.u32(entry.segmentDuration).i32(entry.mediaTime);
        body.i16(entry.rateInteger).i16(entry.rateFraction);
    }
    return makeFullBox("elst", useVersion, flags, body.toBytes());
}

/**
 * The shared prefix of mvhd, mdhd and tkhd: creation and modification times, then a
 * timescale (mvhd, mdhd) or track ID (tkhd), then a duration. tkhd also has 4 reserved
 * bytes before its duration. Everything after the duration is kept verbatim.
 */
export interface TimeHeader {
    version: number;
    flags: number;
    creationTime: number;
    modificationTime: number;
    timescaleOrTrackId: number;
    duration: number;
    rest: Uint8Array;
}

function readTimeHeader(data: Uint8Array, box: Box, isTrackHeader: boolean): TimeHeader {
    const { version, flags, reader } = readFullBox(data, box);
    if (version > 1) throw new UnsupportedError(`Unknown '${box.type}' version ${version}.`);
    const wide = version === 1;
    const creationTime = wide ? reader.u64() : reader.u32();
    const modificationTime = wide ? reader.u64() : reader.u32();
    const timescaleOrTrackId = reader.u32();
    if (isTrackHeader) reader.skip(4);
    const duration = wide ? reader.u64() : reader.u32();
    const rest = reader.bytes(reader.remaining);
    return { version, flags, creationTime, modificationTime, timescaleOrTrackId, duration, rest };
}

function makeTimeHeader(type: string, header: TimeHeader, isTrackHeader: boolean): Uint8Array {
    const fits = header.creationTime <= UINT32_MAX && header.modificationTime <= UINT32_MAX && header.duration <= UINT32_MAX;
    const wide = header.version === 1 || !fits;
    const body = new Writer();
    const time = (value: number) => (wide ? body.u64(value) : body.u32(value));
    time(header.creationTime);
    time(header.modificationTime);
    body.u32(header.timescaleOrTrackId);
    if (isTrackHeader) body.u32(0);
    time(header.duration);
    body.bytes(header.rest);
    return makeFullBox(type, wide ? 1 : 0, header.flags, body.toBytes());
}

/** mvhd or mdhd: `timescaleOrTrackId` is the timescale. */
export function readMediaHeader(data: Uint8Array, box: Box): TimeHeader {
    return readTimeHeader(data, box, false);
}

export function makeMediaHeader(type: "mvhd" | "mdhd", header: TimeHeader): Uint8Array {
    return makeTimeHeader(type, header, false);
}

/** tkhd: `timescaleOrTrackId` is the track ID; the duration is in the movie timescale. */
export function readTrackHeader(data: Uint8Array, box: Box): TimeHeader {
    return readTimeHeader(data, box, true);
}

export function makeTrackHeader(header: TimeHeader): Uint8Array {
    return makeTimeHeader("tkhd", header, true);
}
