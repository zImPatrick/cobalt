// Locates the movie box and the parts of each track we need.

import { childBoxes, findChild, readBoxes, readFullBox, requireChild, type Box } from "./boxes";
import { fourcc, UnsupportedError } from "./bytes";
import { readMediaHeader, readTrackHeader, type TimeHeader } from "./tables";

// Top-level boxes a valid MP4/MOV can start with. Anything else means it isn't one.
const LEADING_BOX_TYPES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "pdin", "junk"]);

export const FRAGMENTED = "Fragmented MP4 files aren't supported.";

/** What every track contributes: its kind and its tkhd (for the movie duration). */
export interface TrackSummary {
    trak: Box;
    handler: string; // 'vide', 'soun', ...
    tkhd: Box;
    trackHeader: TimeHeader; // duration is in the movie timescale
}

/** A track we may rewrite, with the boxes that hold its timing. */
export interface Track extends TrackSummary {
    mdhd: Box;
    mediaHeader: TimeHeader; // timescaleOrTrackId is the media timescale
    elst: Box | undefined;
    stbl: Box;
    stsd: Box;
    sampleEntries: Box[];
    stts: Box;
    ctts: Box | undefined;
    cslg: Box | undefined;
    sampleCount: number; // from stsz/stz2
}

/** Where the top-level boxes are. Offsets are file offsets. */
export interface Layout {
    size: number; // file size
    topLevel: Box[];
    moov: Box; // the one moov, one of topLevel
}

export interface Movie {
    layout: Layout;
    moov: Box; // in the bytes the movie was read from: layout.moov, or at 0 if they are just the moov
    mvhd: Box;
    movieHeader: TimeHeader; // timescaleOrTrackId is the movie timescale
    tracks: TrackSummary[];
}

/** Reads the movie of a file held in memory. Box offsets are file offsets. */
export function readMovie(data: Uint8Array): Movie {
    checkLeadingBox(data);
    const layout = checkLayout(data.length, readBoxes(data, 0, data.length));
    return readMovieBox(data, layout.moov, layout);
}

/** Throws unless the file starts with a box an MP4 or MOV can start with. */
export function checkLeadingBox(start: Uint8Array): void {
    if (start.length < 8 || !LEADING_BOX_TYPES.has(fourcc(start, 4))) {
        throw new UnsupportedError("This doesn't look like an MP4 or MOV file.");
    }
}

/** Checks the top-level boxes: not fragmented, and exactly one moov. */
export function checkLayout(size: number, topLevel: Box[]): Layout {
    if (topLevel.some((box) => box.type === "moof")) {
        throw new UnsupportedError(FRAGMENTED);
    }
    const moovs = topLevel.filter((box) => box.type === "moov");
    if (moovs.length === 0) {
        throw new UnsupportedError("The file has no movie header (moov box); it may be incomplete.");
    }
    if (moovs.length > 1) {
        throw new UnsupportedError("The file has more than one movie header (moov box).");
    }
    return { size, topLevel, moov: moovs[0] };
}

/**
 * Reads the movie box `moov`, found in `data`: either the whole file (`moov` is
 * `layout.moov`) or just the moov box's bytes (`moov` starts at 0). Every box offset in
 * the result is an offset into `data`.
 */
export function readMovieBox(data: Uint8Array, moov: Box, layout: Layout): Movie {
    if (findChild(data, moov, "mvex")) {
        throw new UnsupportedError(FRAGMENTED);
    }
    const mvhd = requireChild(data, moov, "mvhd");
    const movieHeader = readMediaHeader(data, mvhd);
    if (movieHeader.timescaleOrTrackId === 0) {
        throw new UnsupportedError("The movie header has a zero timescale.");
    }
    const tracks = childBoxes(data, moov)
        .filter((box) => box.type === "trak")
        .map((trak) => readTrackSummary(data, trak));
    return { layout, moov, mvhd, movieHeader, tracks };
}

function readTrackSummary(data: Uint8Array, trak: Box): TrackSummary {
    const tkhd = requireChild(data, trak, "tkhd");
    const mdia = requireChild(data, trak, "mdia");
    const hdlr = requireChild(data, mdia, "hdlr");
    // hdlr: version/flags, pre_defined (4), handler_type (4)
    const reader = readFullBox(data, hdlr).reader;
    reader.skip(4);
    const handler = fourcc(reader.bytes(4), 0);
    return { trak, handler, tkhd, trackHeader: readTrackHeader(data, tkhd) };
}

/** `fileSize` is the size of the whole file, for a sanity check on the sample sizes. */
export function readTrack(data: Uint8Array, summary: TrackSummary, fileSize: number): Track {
    const { trak } = summary;
    const edts = findChild(data, trak, "edts");
    const mdia = requireChild(data, trak, "mdia");
    const mdhd = requireChild(data, mdia, "mdhd");
    const minf = requireChild(data, mdia, "minf");
    const stbl = requireChild(data, minf, "stbl");
    const stsd = requireChild(data, stbl, "stsd");
    const stts = requireChild(data, stbl, "stts");
    const sizes = findChild(data, stbl, "stsz") ?? requireChild(data, stbl, "stz2");

    // stsd: version/flags, entry_count, then the sample entries as boxes.
    const stsdReader = readFullBox(data, stsd).reader;
    stsdReader.skip(4);
    const sampleEntries = readBoxes(data, stsdReader.pos, stsd.end);

    // stsz: version/flags, sample_size, sample_count.
    // stz2: version/flags, reserved (3), field_size (1), sample_count. Same offset either way.
    const sizesReader = readFullBox(data, sizes).reader;
    const fixedSize = sizesReader.u32();
    const sampleCount = sizesReader.u32();
    if (sizes.type === "stsz" && fixedSize === 0 && sampleCount * 4 > sizesReader.remaining) {
        throw new UnsupportedError("The sample size table is corrupt.");
    }
    if (sizes.type === "stsz" && fixedSize > 0 && sampleCount * fixedSize > fileSize) {
        throw new UnsupportedError("The sample size table is corrupt.");
    }

    const mediaHeader = readMediaHeader(data, mdhd);
    if (mediaHeader.timescaleOrTrackId === 0) {
        throw new UnsupportedError("A track has a zero timescale.");
    }

    return {
        ...summary,
        mdhd,
        mediaHeader,
        elst: edts ? findChild(data, edts, "elst") : undefined,
        stbl,
        stsd,
        sampleEntries,
        stts,
        ctts: findChild(data, stbl, "ctts"),
        cslg: findChild(data, stbl, "cslg"),
        sampleCount
    };
}
