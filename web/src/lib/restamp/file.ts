// Reads a file through the Blob API, for files too large to hold in memory: only the
// top-level box headers and the moov box are read, and the fixed file is assembled from
// slices of the original.

import { readBoxHeader, type Box } from "./boxes";
import { UnsupportedError } from "./bytes";
import { failedInspection, inspectMovie, type Inspection, type Plan } from "./detect";
import { checkLayout, checkLeadingBox, FRAGMENTED, readMovieBox, type Layout, type Movie } from "./movie";
import { buildMoov, moovPlacement } from "./rewrite";

// The moov is read into memory whole. Even an hour of 60 fps video with audio has a moov
// of a few MB, so anything this big is more likely corrupt than real.
export const MAX_MOOV_SIZE = 64 * 1024 * 1024;

export interface FileInspection extends Inspection {
    moov: Uint8Array | null; // the moov box's bytes, which the plan's box offsets refer to
}

export async function inspectFile(file: Blob): Promise<FileInspection> {
    try {
        const layout = await readLayout(file);
        const { moov } = layout;
        if (moov.end - moov.start > MAX_MOOV_SIZE) {
            throw new UnsupportedError(`The movie header (moov box) is larger than ${MAX_MOOV_SIZE / 2 ** 20} MiB, which isn't supported.`);
        }
        const data = await read(file, moov.start, moov.end);
        const movie = readMovieBox(data, { ...moov, start: 0, end: data.length }, layout);
        return { ...inspectMovie(data, movie), moov: data };
    } catch (error) {
        return { ...failedInspection(error), moov: null };
    }
}

/** The top-level boxes, read one header at a time. Same checks as `readMovie`. */
async function readLayout(file: Blob): Promise<Layout> {
    const { size } = file;
    checkLeadingBox(await read(file, 0, 16));
    const topLevel: Box[] = [];
    let pos = 0;
    // Fewer than 8 bytes can't hold a box header; see readBoxes.
    while (size - pos >= 8) {
        const box = readBoxHeader(await read(file, pos, pos + 16), pos, size);
        // A fragmented file can have thousands of fragments; no need to visit them all.
        if (box.type === "moof") throw new UnsupportedError(FRAGMENTED);
        topLevel.push(box);
        pos = box.end;
    }
    return checkLayout(size, topLevel);
}

async function read(file: Blob, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Like `applyPlan`, for a file read by `inspectFile`: `moov` is the moov box's bytes. */
export function applyPlanToFile(file: Blob, moov: Uint8Array, plan: Plan): Blob {
    return placeMoovInFile(file, plan.movie, buildMoov(moov, plan));
}

/** Like `placeMoov`: the new moov placed among slices of the original file. */
export function placeMoovInFile(file: Blob, movie: Movie, newMoov: Uint8Array): Blob {
    const pieces = moovPlacement(movie.layout, newMoov);
    const parts = pieces.map((piece) => (piece instanceof Uint8Array ? (piece as BlobPart) : file.slice(piece.start, piece.end)));
    return new Blob(parts, { type: file.type });
}
