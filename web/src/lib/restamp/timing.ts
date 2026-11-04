// Computes corrected timing for a track: new sample durations, composition offsets,
// media duration and edit list. Nothing here touches the file; rewrite.ts writes it out.

import { UINT32_MAX, UnsupportedError } from "./bytes";
import type { Track } from "./movie";
import { readElst, toRuns, type CompositionShift, type DurationRun, type EditEntry, type OffsetRun } from "./tables";

/** Corrected timing for one track. */
export interface Retimed {
    track: Track;
    timescale: number; // media timescale (mdhd); may differ from the original for video
    durations: DurationRun[]; // stts
    offsets: { version: number; runs: OffsetRun[] } | null; // ctts, when the track has one
    compositionShift: CompositionShift | null; // cslg, when the track has one
    mediaDuration: number; // mdhd duration: sum of the sample durations
    edit: EditEntry | null; // the single edit list entry, when the track has one
    trackDuration: number; // tkhd duration, in the movie timescale
}

/** A video track's timing as stored, in its own media ticks. */
export interface VideoTiming {
    timescale: number;
    mediaDuration: number; // mdhd duration as stored
    durations: Float64Array; // per frame, decode order
    offsets: { version: number; values: Float64Array } | null; // ctts, per frame
    edit: EditEntry | null;
}

/**
 * Reads a track's edit list. We handle none, or a single normal-speed segment: that's what
 * muxers write to trim encoder delay (audio priming, or the B-frame reorder delay on video)
 * or to cut a clip without re-encoding.
 */
export function readEdit(data: Uint8Array, track: Track, mediaDuration: number): EditEntry | null {
    if (!track.elst) return null;
    const { entries } = readElst(data, track.elst);
    if (entries.length === 0) return null;
    const kind = track.handler === "vide" ? "video" : "audio";
    if (entries.length > 1) {
        throw new UnsupportedError(`The ${kind} track has a multi-part edit list, which isn't supported.`);
    }
    const [edit] = entries;
    if (edit.mediaTime < 0) {
        throw new UnsupportedError(`The ${kind} track's edit list contains only an empty edit.`);
    }
    if (edit.mediaTime >= mediaDuration) {
        throw new UnsupportedError(`The ${kind} track's edit list starts after the end of its media.`);
    }
    if (edit.rateInteger !== 1 || edit.rateFraction !== 0) {
        throw new UnsupportedError(`The ${kind} track's edit list changes the playback rate, which isn't supported.`);
    }
    return edit;
}

/**
 * How long a track plays: from the edit's start (media_time) to `mediaEnd`, capped by the
 * edit's duration. Without an edit list, the whole media duration.
 */
export function presentedSeconds(mediaEnd: number, edit: EditEntry | null, timescale: number, movieTimescale: number): number {
    const span = (mediaEnd - (edit?.mediaTime ?? 0)) / timescale;
    return edit ? Math.min(span, edit.segmentDuration / movieTimescale) : span;
}

/**
 * How long the video plays. With an edit list that is measured from media_time to the end of
 * the last frame shown, so frames a trim hides don't count.
 */
export function videoPresentedSeconds(video: VideoTiming, movieTimescale: number): number {
    if (!video.edit) return sum(video.durations) / video.timescale;
    return presentedSeconds(presentationEnd(video.durations, video.offsets?.values), video.edit, video.timescale, movieTimescale);
}

export function sum(values: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[i];
    return total;
}

export function median(values: ArrayLike<number>): number {
    if (values.length === 0) return NaN;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The value occurring most often (the smallest one on a tie). */
export function mostCommon(values: ArrayLike<number>): number {
    const counts = new Map<number, number>();
    let best = values[0];
    for (let i = 0; i < values.length; i++) {
        const count = (counts.get(values[i]) ?? 0) + 1;
        counts.set(values[i], count);
        const bestCount = counts.get(best) ?? 0;
        if (count > bestCount || (count === bestCount && values[i] < best)) best = values[i];
    }
    return best;
}

/**
 * Audio whose packets claim the wrong duration: every packet gets its real duration,
 * `packetDuration` ticks. The final packet is usually shorter on purpose (it trims the
 * encoder's padding), so it is scaled by the same stretch as the rest, capped at a packet.
 *
 * `packetDuration` may be fractional here (when the media timescale isn't a multiple of
 * the core sample rate); that's fine for measuring, and checked before writing.
 */
export function retimeAudio(
    track: Track,
    oldDurations: Float64Array,
    edit: EditEntry | null,
    packetDuration: number,
    movieTimescale: number
): Retimed {
    const timescale = track.mediaHeader.timescaleOrTrackId;
    const count = oldDurations.length;
    const last = count - 1;
    const stretch = count > 1 ? (sum(oldDurations) - oldDurations[last]) / (last * packetDuration) : 1;
    const durations = new Float64Array(count).fill(packetDuration);
    durations[last] = Math.min(packetDuration, Math.round(oldDurations[last] / stretch));
    const mediaDuration = sum(durations);

    let newEdit: EditEntry | null = null;
    if (edit) {
        // media_time is the priming to skip, in media ticks. Map it onto the new timeline
        // sample by sample: it often falls inside the first packets, which may be timed right.
        const mediaTime = Math.round(mapTime(oldDurations, durations, edit.mediaTime));
        const oldSpan = sum(oldDurations) - edit.mediaTime;
        const newSpan = mediaDuration - mediaTime;
        const scaled = oldSpan > 0 ? Math.round((edit.segmentDuration * newSpan) / oldSpan) : Infinity;
        newEdit = { ...edit, mediaTime, segmentDuration: capSegment(scaled, newSpan, timescale, movieTimescale) };
    }

    return {
        track,
        timescale,
        durations: toRuns(durations).map(({ count, value }) => ({ count, delta: value })),
        offsets: null,
        compositionShift: null,
        mediaDuration,
        edit: newEdit,
        trackDuration: newEdit ? newEdit.segmentDuration : Math.round((mediaDuration * movieTimescale) / timescale)
    };
}

// How far the scaled video may end from where it should, when the factor can't be exact.
// Very long clips at large timescales may only get close; we then take the best we can.
const VIDEO_LENGTH_PRECISION_SECONDS = 0.001;
const MAX_TIMESCALE_MULTIPLIER = 100_000;

/**
 * Video: every timestamp (decode and presentation time of each frame, and the edit's
 * media_time) is multiplied by `ratio`, the new length over the old. Scaling the original
 * timestamps rather than laying frames on a uniform grid keeps variable frame rates, and
 * since scaling preserves order, frames are presented in the same order as before.
 *
 * Timestamps are integers, so we pick a new timescale (a multiple of the old one) and
 * scale by s = d / D new ticks per old tick, where D is the most common old frame duration
 * and d an integer: frames of the usual length then come out exactly d ticks long. Times are
 * rounded individually (not durations), so rounding never accumulates into drift.
 *
 * - `snappedFps` set: ratio is exactly T / (fps x D), so we need d = T' / fps with T' the
 *   new timescale. That is the old timescale when it is a multiple of fps (15360, 90000 and
 *   600 are for 60 fps), otherwise the least common multiple of the two. A constant-rate
 *   input then comes out with a single uniform stts entry at exactly that rate.
 * - Otherwise ratio is approximated: the timescale is multiplied until d / (D x multiplier)
 *   is within VIDEO_LENGTH_PRECISION_SECONDS of the exact length over the whole clip (or as
 *   close as a 32-bit timescale allows).
 *
 * Either way the timescale is also raised until the closest two distinct presentation
 * times stay at least a tick apart, so rounding can't merge or reorder frames.
 */
export function retimeVideo(track: Track, video: VideoTiming, ratio: number, snappedFps: number | null, movieTimescale: number): Retimed {
    const oldTimescale = video.timescale;
    const { durations: oldDurations } = video;
    const frames = oldDurations.length;
    const oldTotal = sum(oldDurations);
    const oldDecode = decodeTimes(oldDurations);
    const oldPresentation = Float64Array.from(oldDecode.subarray(0, frames), (time, i) => time + (video.offsets?.values[i] ?? 0));

    const usual = mostCommon(oldDurations);
    const minimumGap = smallestGap(oldPresentation);
    let latest = oldTotal;
    for (const time of oldPresentation) latest = Math.max(latest, time);
    const step = snappedFps ? snappedFps / gcd(oldTimescale, snappedFps) : 1;
    let best: { multiplier: number; usualNew: number; error: number } | null = null;
    for (let m = step; m <= MAX_TIMESCALE_MULTIPLIER && oldTimescale * m <= UINT32_MAX; m += step) {
        const d = Math.round(usual * ratio * m);
        if (latest * d > Number.MAX_SAFE_INTEGER) break; // keep time * d exact in a double
        if (d < 1 || (d / usual) * minimumGap < 1) continue;
        const error = snappedFps ? 0 : Math.abs(d / (usual * m) - ratio) * (oldTotal / oldTimescale);
        if (!best || error < best.error) best = { multiplier: m, usualNew: d, error };
        if (error <= VIDEO_LENGTH_PRECISION_SECONDS) break;
    }
    if (!best) {
        throw new UnsupportedError("The video track's timescale can't represent the corrected frame rate.");
    }
    const { multiplier, usualNew } = best;
    const timescale = oldTimescale * multiplier;
    const scale = (time: number) => Math.round((time * usualNew) / usual);

    const newDecode = oldDecode.map(scale);
    const durations = new Float64Array(frames);
    for (let i = 0; i < frames; i++) durations[i] = newDecode[i + 1] - newDecode[i];
    // Snapping means the input is constant-rate except perhaps the last frame, whose odd
    // duration is usually a muxer artifact. Give it the regular duration too, so the output is
    // exactly uniform. Only that frame's own display time changes; no timestamp moves.
    if (snappedFps) durations[frames - 1] = usualNew;
    if (durations.some((duration) => duration > UINT32_MAX)) {
        throw new UnsupportedError("The video's frame durations are too large to rescale.");
    }
    // mdhd: at least the sum of the durations. Some muxers (ffmpeg) store the presentation
    // span there instead, which includes the B-frame delay, and players then report it as the
    // length; scaling the stored value keeps that.
    const mediaDuration = Math.max(newDecode[frames - 1] + durations[frames - 1], scale(video.mediaDuration));

    let offsets: Retimed["offsets"] = null;
    let compositionShift: CompositionShift | null = null;
    let newEnd = mediaDuration;
    if (video.offsets) {
        const values = new Float64Array(frames);
        let least = Infinity;
        let greatest = -Infinity;
        let start = Infinity;
        newEnd = -Infinity;
        for (let i = 0; i < frames; i++) {
            const presentation = scale(oldPresentation[i]);
            values[i] = presentation - newDecode[i];
            least = Math.min(least, values[i]);
            greatest = Math.max(greatest, values[i]);
            start = Math.min(start, presentation);
            newEnd = Math.max(newEnd, presentation + durations[i]);
        }
        // Version 0 offsets are unsigned. Scaling keeps them >= 0 unless the input already
        // stored negative ones in a version 0 box, in which case we say so with version 1.
        const version = least < 0 ? 1 : video.offsets.version;
        // ctts has no 64-bit variant.
        const fits = version === 0 ? greatest <= UINT32_MAX : least >= -0x80000000 && greatest <= 0x7fffffff;
        if (!fits) throw new UnsupportedError("The video's composition offsets are too large to rescale.");
        offsets = { version, runs: toRuns(values).map(({ count, value }) => ({ count, offset: value })) };
        compositionShift = {
            compositionToDtsShift: Math.max(0, -least),
            leastDecodeToDisplayDelta: least,
            greatestDecodeToDisplayDelta: greatest,
            compositionStartTime: start,
            compositionEndTime: newEnd
        };
    }

    let edit: EditEntry | null = null;
    if (video.edit) {
        const mediaTime = scale(video.edit.mediaTime);
        const exactRatio = usualNew / (usual * multiplier); // new seconds per old second
        const scaled = Math.round(video.edit.segmentDuration * exactRatio);
        edit = { ...video.edit, mediaTime, segmentDuration: capSegment(scaled, newEnd - mediaTime, timescale, movieTimescale) };
    }

    return {
        track,
        timescale,
        durations: toRuns(durations).map(({ count, value }) => ({ count, delta: value })),
        offsets,
        compositionShift,
        mediaDuration,
        edit,
        trackDuration: edit ? edit.segmentDuration : Math.round((mediaDuration * movieTimescale) / timescale)
    };
}

/**
 * An edit's new duration (movie timescale) is the old one scaled, so a deliberate trim
 * survives, but never past the end of the media (`available` media ticks after media_time).
 * Muxers often write the full media duration here without subtracting media_time.
 */
function capSegment(scaled: number, available: number, timescale: number, movieTimescale: number): number {
    return Math.max(0, Math.min(scaled, Math.round((available * movieTimescale) / timescale)));
}

/** Decode time of each frame, plus the end of the last one (length frames + 1). */
function decodeTimes(durations: Float64Array): Float64Array {
    const times = new Float64Array(durations.length + 1);
    for (let i = 0; i < durations.length; i++) times[i + 1] = times[i] + durations[i];
    return times;
}

/** End of the last frame shown: the latest presentation time plus that frame's duration. */
function presentationEnd(durations: Float64Array, offsets: Float64Array | undefined): number {
    if (!offsets) return sum(durations);
    let end = -Infinity;
    let decode = 0;
    for (let i = 0; i < durations.length; i++) {
        end = Math.max(end, decode + offsets[i] + durations[i]);
        decode += durations[i];
    }
    return end;
}

/** The smallest difference between two distinct values (Infinity if there aren't two). */
function smallestGap(values: Float64Array): number {
    const sorted = Float64Array.from(values).sort();
    let gap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] > sorted[i - 1]) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
    }
    return gap;
}

/** Maps a time on the old timeline to the same point (proportionally within its sample) on the new one. */
function mapTime(oldDurations: Float64Array, newDurations: Float64Array, time: number): number {
    let oldStart = 0;
    let newStart = 0;
    for (let i = 0; i < oldDurations.length; i++) {
        if (time < oldStart + oldDurations[i]) {
            return newStart + ((time - oldStart) * newDurations[i]) / oldDurations[i];
        }
        oldStart += oldDurations[i];
        newStart += newDurations[i];
    }
    return newStart;
}

function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}
