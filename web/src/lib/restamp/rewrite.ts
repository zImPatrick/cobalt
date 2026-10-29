// Writes the corrected timing back into the file. Only the moov box changes; media data
// (mdat) never moves, so every chunk offset (stco/co64) stays valid.

import { childBoxes, makeBox, makeFreeBox, payloadStart, readFullBox, type Box } from "./boxes";
import { concatBytes, UINT32_MAX, UnsupportedError, Writer } from "./bytes";
import { isEnabled, type Plan } from "./detect";
import type { Layout, Movie } from "./movie";
import { makeCslg, makeCtts, makeElst, makeMediaHeader, makeStts, makeTrackHeader, readElst } from "./tables";
import type { Retimed } from "./timing";

// Boxes we descend into to reach the ones we replace. None of them has fields of its own.
const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "stbl"]);

export function applyPlan(data: Uint8Array, plan: Plan): Uint8Array {
    const newMoov = buildMoov(data, plan);
    return placeMoov(data, plan.movie, newMoov);
}

/** The corrected moov box. */
export function buildMoov(data: Uint8Array, plan: Plan): Uint8Array {
    const { movie } = plan;
    const replacements = new Map<number, Uint8Array>(); // original box offset -> new box
    const fixed = [plan.video, plan.audio].filter((track): track is Retimed => track !== null);
    for (const retimed of fixed) addTrackReplacements(data, retimed, replacements);

    // The movie lasts as long as its longest track. Disabled tracks aren't played (and we
    // don't retime them), so they don't count.
    let movieDuration = 0;
    for (const track of movie.tracks) {
        if (!isEnabled(track) && !fixed.some((candidate) => candidate.track.trak.start === track.trak.start)) continue;
        const retimed = fixed.find((candidate) => candidate.track.trak.start === track.trak.start);
        movieDuration = Math.max(movieDuration, retimed ? retimed.trackDuration : track.trackHeader.duration);
    }
    replacements.set(movie.mvhd.start, makeMediaHeader("mvhd", { ...movie.movieHeader, duration: movieDuration }));

    return rebuildBox(data, movie.moov, replacements);
}

function addTrackReplacements(data: Uint8Array, retimed: Retimed, replacements: Map<number, Uint8Array>): void {
    const { track } = retimed;
    replacements.set(
        track.mdhd.start,
        makeMediaHeader("mdhd", { ...track.mediaHeader, timescaleOrTrackId: retimed.timescale, duration: retimed.mediaDuration })
    );
    replacements.set(track.stts.start, makeStts(retimed.durations));
    if (track.ctts && retimed.offsets) {
        replacements.set(track.ctts.start, makeCtts(retimed.offsets.version, retimed.offsets.runs));
    }
    if (track.cslg && retimed.compositionShift) {
        replacements.set(track.cslg.start, makeCslg(readFullBox(data, track.cslg).version, retimed.compositionShift));
    }
    if (track.elst && retimed.edit) {
        const { version, flags } = readElst(data, track.elst);
        replacements.set(track.elst.start, makeElst(version, flags, [retimed.edit]));
    }
    replacements.set(track.tkhd.start, makeTrackHeader({ ...track.trackHeader, duration: retimed.trackDuration }));
}

/** Copies a box, swapping in replacements (keyed by original offset) wherever they are. */
function rebuildBox(data: Uint8Array, box: Box, replacements: Map<number, Uint8Array>): Uint8Array {
    const replacement = replacements.get(box.start);
    if (replacement) return replacement;
    const containsReplacement = [...replacements.keys()].some((start) => start > box.start && start < box.end);
    if (!CONTAINERS.has(box.type) || !containsReplacement) return data.slice(box.start, box.end);

    const children = childBoxes(data, box);
    const parts = children.map((child) => rebuildBox(data, child, replacements));
    // Keep any trailing bytes too short to be a box, so nothing is silently dropped.
    const childrenEnd = children.length ? children[children.length - 1].end : payloadStart(box);
    parts.push(data.slice(childrenEnd, box.end));
    return makeBox(box.type, concatBytes(parts));
}

/** A piece of the output file: a range [start, end) of the input file, or new bytes. */
export type Piece = { start: number; end: number } | Uint8Array;

/** The fixed file in memory: `moovPlacement` applied to the input bytes. */
export function placeMoov(data: Uint8Array, movie: Movie, newMoov: Uint8Array): Uint8Array {
    const pieces = moovPlacement(movie.layout, newMoov);
    return concatBytes(pieces.map((piece) => (piece instanceof Uint8Array ? piece : data.subarray(piece.start, piece.end))));
}

/**
 * Puts the new moov into the file without moving any other box:
 * 1. If it fits where the old one was, write it there and fill the rest with a `free` box
 *    (which needs at least 8 bytes), so the file size and every offset are unchanged.
 * 2. Otherwise, if the old moov is the last box, just replace it; nothing follows it.
 * 3. Otherwise append the new moov at the end and turn the old one into `free`.
 * Returns the output as pieces, so it can be assembled from bytes in memory or from a Blob.
 */
export function moovPlacement(layout: Layout, newMoov: Uint8Array): Piece[] {
    const { size, topLevel, moov } = layout;
    const slack = moov.end - moov.start - newMoov.length;
    if (slack === 0 || slack >= 8) {
        const filler = slack > 0 ? [makeFreeBox(slack)] : [];
        return [{ start: 0, end: moov.start }, newMoov, ...filler, { start: moov.end, end: size }];
    }

    const last = topLevel[topLevel.length - 1];
    if (last === moov) {
        return [{ start: 0, end: moov.start }, newMoov];
    }

    // Anything past the last box is too short to be a box; drop it so the appended moov
    // directly follows a complete box.
    const pieces: Piece[] = [{ start: 0, end: moov.start + 4 }, new Uint8Array([0x66, 0x72, 0x65, 0x65])]; // 'free'
    if (last.extendsToEnd) {
        // A size of 0 means "to the end of the file", which would now swallow the new moov.
        const lastSize = last.end - last.start;
        if (last.headerSize !== 8 || lastSize > UINT32_MAX) {
            throw new UnsupportedError("The corrected header doesn't fit in the file's layout.");
        }
        pieces.push({ start: moov.start + 8, end: last.start }, new Writer().u32(lastSize).toBytes(), { start: last.start + 4, end: last.end });
    } else {
        pieces.push({ start: moov.start + 8, end: last.end });
    }
    pieces.push(newMoov);
    return pieces;
}
