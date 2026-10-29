// Decides whether a file's timestamps are stretched, and by how much. Only the moov headers
// are read; no media is decoded.
//
// The evidence comes from the audio. An AAC packet always decodes to the same number of
// samples, so its true duration is known. If the packets claim a duration far from that
// (the TikTok case: ~2x), the timestamps are stretched, and the real length is the packet
// count times the true duration. A file whose audio packets are timed right, but whose video
// is longer or shorter than the audio, is ambiguous: the video may be stretched, or the
// audio may simply not cover the whole clip. That is reported as 'suspect' and only fixed
// on request.

import { readAacConfig } from "./aac";
import { UnsupportedError } from "./bytes";
import { readMovie, readTrack, type Movie, type Track, type TrackSummary } from "./movie";
import { expandDurations, expandOffsets, readCtts, readStts } from "./tables";
import {
    median,
    presentedSeconds,
    readEdit,
    retimeAudio,
    retimeVideo,
    sum,
    videoPresentedSeconds,
    type Retimed,
    type VideoTiming
} from "./timing";
import type { Analysis } from "./types";

// Audio packets count as stretched when their median duration is this far from the true
// one. Robust to a few odd packets: a gap, or a long first packet covering encoder delay.
const AUDIO_STRETCH_THRESHOLD = 0.1;

// How far the video length may be from the real one before we call it wrong: 2%, but at
// least 100 ms, since even correct short clips often have audio a few packets longer or
// shorter than the video (encoder delay, B-frame delay without an edit list).
const LENGTH_TOLERANCE = 0.02;
const LENGTH_TOLERANCE_SECONDS = 0.1;

// When both tracks are stretched they must be stretched alike for us to be confident.
const FACTOR_AGREEMENT = 0.05;

// Constant-rate video is snapped to one of these when that still ends with the audio, within
// a frame or this many seconds. Otherwise the exact factor is used, so long clips at 59.94 or
// 29.97 fps don't drift. Only whole numbers: on a short clip a length measured to the nearest
// audio packet can't tell 59.94 from 60.
const STANDARD_FRAME_RATES = [24, 25, 30, 48, 50, 60, 90, 100, 120];
const SNAP_LENGTH_TOLERANCE_SECONDS = 0.02;

// Outside this range the audio clearly doesn't span the video, so it can't tell us the speed.
const PLAUSIBLE_FRAME_RATES = { min: 1, max: 240 };

/** The corrected timing to write: null for a track that is already right. */
export interface Plan {
    movie: Movie;
    video: Retimed | null;
    audio: Retimed | null;
}

export interface Inspection {
    analysis: Analysis;
    plan: Plan | null; // set when analysis.status is 'broken' or 'suspect'
}

export function inspect(data: Uint8Array): Inspection {
    try {
        return inspectMovie(data, readMovie(data));
    } catch (error) {
        return failedInspection(error);
    }
}

/** What to report for an error thrown while reading a file. */
export function failedInspection(error: unknown): Inspection {
    // Anything but UnsupportedError is a bug or an input we didn't anticipate; still never throw at callers.
    const reason =
        error instanceof UnsupportedError ? error.message : "The file could not be read; it may be corrupt or use features we don't support.";
    return { analysis: { status: "unsupported", reason }, plan: null };
}

/** Inspects a movie read from `data` (the whole file, or just its moov). Throws UnsupportedError. */
export function inspectMovie(data: Uint8Array, movie: Movie): Inspection {
    const movieTimescale = movie.movieHeader.timescaleOrTrackId;

    const videoSummary = movie.tracks.find((track) => track.handler === "vide");
    if (!videoSummary) throw new UnsupportedError("The file has no video track.");
    const audioSummary = movie.tracks.find((track) => track.handler === "soun");
    if (!audioSummary) {
        throw new UnsupportedError("The file has no audio track, so its real length can't be worked out.");
    }
    const others = movie.tracks.filter((track) => track !== videoSummary && track !== audioSummary && isEnabled(track));
    if (others.length > 0) {
        throw new UnsupportedError(
            `The file has ${movie.tracks.length} tracks. Only files with one video and one audio track are supported, ` +
                "because the other tracks would keep their old timing."
        );
    }
    const video = readTrack(data, videoSummary, movie.layout.size);
    const audio = readTrack(data, audioSummary, movie.layout.size);

    // Audio
    if (audio.sampleCount === 0) throw new UnsupportedError("The audio track is empty.");
    if (audio.sampleEntries.length !== 1) {
        throw new UnsupportedError("The audio track has more than one sample description.");
    }
    const aac = readAacConfig(data, audio.sampleEntries[0]);
    const audioTimescale = audio.mediaHeader.timescaleOrTrackId;
    // A packet lasts coreSamplesPerFrame / coreSampleRate seconds whether or not SBR doubles
    // the output rate, so this also covers implicit SBR (mdhd timescale = 2x the core rate).
    const packetDuration = (aac.coreSamplesPerFrame * audioTimescale) / aac.coreSampleRate;
    const implicitSbr =
        aac.sbrSampleRate === undefined && !aac.sbrExcluded && aac.coreSampleRate <= 24000 && audioTimescale === 2 * aac.coreSampleRate;
    const outputSampleRate = aac.sbrSampleRate ?? (implicitSbr ? audioTimescale : aac.coreSampleRate);

    const audioDurations = expandDurations(readStts(data, audio.stts), audio.sampleCount);
    const audioEdit = readEdit(data, audio, sum(audioDurations));
    const claimedAudioSeconds = presentedSeconds(sum(audioDurations), audioEdit, audioTimescale, movieTimescale);
    // The last packet is often short on purpose, so it doesn't count towards the median.
    const typicalPacket = median(audioDurations.subarray(0, audioDurations.length - 1));
    const audioStretched = Math.abs(typicalPacket / packetDuration - 1) > AUDIO_STRETCH_THRESHOLD;
    // Audio that isn't stretched is trusted as it is, gaps and all.
    const correctedAudio = audioStretched ? retimeAudio(audio, audioDurations, audioEdit, packetDuration, movieTimescale) : null;
    const realSeconds = correctedAudio
        ? presentedSeconds(correctedAudio.mediaDuration, correctedAudio.edit, audioTimescale, movieTimescale)
        : claimedAudioSeconds;
    if (!(realSeconds > 0)) throw new UnsupportedError("The audio track has no playable length.");
    const audioFactor = claimedAudioSeconds / realSeconds;

    // Video
    const frames = video.sampleCount;
    if (frames === 0) throw new UnsupportedError("The video track has no frames.");
    const videoDurations = expandDurations(readStts(data, video.stts), frames);
    const videoTiming: VideoTiming = {
        timescale: video.mediaHeader.timescaleOrTrackId,
        mediaDuration: video.mediaHeader.duration,
        durations: videoDurations,
        offsets: readVideoOffsets(data, video),
        edit: readEdit(data, video, sum(videoDurations))
    };
    const claimedVideoSeconds = videoPresentedSeconds(videoTiming, movieTimescale);
    const totalVideoSeconds = sum(videoDurations) / videoTiming.timescale;
    if (!(claimedVideoSeconds > 0 && totalVideoSeconds > 0)) throw new UnsupportedError("The video track has no length.");
    const speedFactor = claimedVideoSeconds / realSeconds;
    const labelledFps = frames / totalVideoSeconds;
    const snap = snapFrameRate(videoTiming, claimedVideoSeconds, realSeconds);
    const measuredFps = labelledFps * speedFactor;

    const videoOff = Math.abs(claimedVideoSeconds - realSeconds) > Math.max(LENGTH_TOLERANCE * realSeconds, LENGTH_TOLERANCE_SECONDS);
    let status: "ok" | "broken" | "suspect";
    if (audioStretched) {
        status = !videoOff || Math.abs(speedFactor / audioFactor - 1) <= FACTOR_AGREEMENT ? "broken" : "suspect";
    } else {
        status = videoOff ? "suspect" : "ok";
    }

    const analysis: Analysis = {
        status,
        realSeconds,
        speedFactor,
        video: {
            codec: video.sampleEntries[0]?.type ?? "unknown",
            frames,
            claimedSeconds: claimedVideoSeconds,
            labelledFps,
            // Video timed right is reported as labelled; otherwise what it really is.
            realFps: videoOff ? (snap?.fps ?? measuredFps) : labelledFps,
            needsFix: videoOff
        },
        audio: {
            codec: audio.sampleEntries[0].type,
            profile: implicitSbr ? "HE-AAC" : aac.profile,
            sampleRate: outputSampleRate,
            claimedSeconds: claimedAudioSeconds,
            needsFix: audioStretched
        }
    };
    if (status === "ok") return { analysis, plan: null };

    let videoFix: Retimed | null = null;
    if (videoOff) {
        if (measuredFps < PLAUSIBLE_FRAME_RATES.min || measuredFps > PLAUSIBLE_FRAME_RATES.max) {
            throw new UnsupportedError(
                `The audio and video lengths are too far apart to work out the frame rate (it would be ${measuredFps.toFixed(1)} fps).`
            );
        }
        const ratio = snap?.ratio ?? 1 / speedFactor;
        videoFix = retimeVideo(video, videoTiming, ratio, snap?.fps ?? null, movieTimescale);
    }
    if (correctedAudio) checkAudioFixable(audio, packetDuration);

    return { analysis, plan: { movie, video: videoFix, audio: correctedAudio } };
}

export function isEnabled(track: TrackSummary): boolean {
    return (track.trackHeader.flags & 1) === 1; // tkhd flag track_enabled
}

/**
 * For constant-rate video (every frame the same length, except perhaps the last), the
 * whole-number rate nearest to the corrected one, and the ratio (new length / old) that
 * gives exactly that rate. Null when the video isn't constant-rate, or when snapping would
 * make it end more than a frame (or SNAP_LENGTH_TOLERANCE_SECONDS) away from the audio.
 */
function snapFrameRate(video: VideoTiming, claimedSeconds: number, realSeconds: number): { fps: number; ratio: number } | null {
    const { durations, timescale } = video;
    const usual = durations[0];
    for (let i = 1; i < durations.length - 1; i++) {
        if (durations[i] !== usual) return null;
    }
    const corrected = (timescale / usual) * (claimedSeconds / realSeconds);
    let fps = STANDARD_FRAME_RATES[0];
    for (const rate of STANDARD_FRAME_RATES) {
        if (Math.abs(corrected - rate) < Math.abs(corrected - fps)) fps = rate;
    }
    const ratio = timescale / (fps * usual);
    const tolerance = Math.max(1 / fps, SNAP_LENGTH_TOLERANCE_SECONDS);
    return Math.abs(claimedSeconds * ratio - realSeconds) <= tolerance ? { fps, ratio } : null;
}

function readVideoOffsets(data: Uint8Array, video: Track): VideoTiming["offsets"] {
    if (!video.ctts) return null;
    const { version, runs } = readCtts(data, video.ctts);
    return { version, values: expandOffsets(runs, video.sampleCount) };
}

function checkAudioFixable(audio: Track, packetDuration: number): void {
    if (!Number.isInteger(packetDuration)) {
        throw new UnsupportedError("The audio track's timescale isn't a multiple of its sample rate, so its timestamps can't be corrected exactly.");
    }
    if (audio.ctts) {
        throw new UnsupportedError("The audio track has composition offsets, which AAC never needs; not touching it.");
    }
}
