// Public contract between the restamp core and the UI. Keep this stable.

export interface VideoReport {
    codec: string; // sample entry fourcc, e.g. "avc1", "hvc1"
    frames: number;
    claimedSeconds: number; // how long the timestamps say the video plays (respecting its edit list)
    labelledFps: number; // average rate the timestamps give: frames / total frame duration
    realFps: number; // labelledFps when right; else labelledFps x speedFactor, or the whole-number rate it snaps to
    needsFix: boolean; // its timestamps disagree with the real length (for 'suspect', possibly)
}

export interface AudioReport {
    codec: string; // e.g. "mp4a"
    profile: string; // e.g. "AAC-LC", "HE-AAC"
    sampleRate: number; // output sample rate
    claimedSeconds: number; // how long the timestamps say the audio plays (respecting its edit list)
    needsFix: boolean; // its packets claim the wrong duration
}

/**
 * - 'ok': timestamps agree with the real length; nothing to do.
 * - 'broken': the audio packets themselves claim the wrong duration, and the video (if off
 *   at all) is off by the same factor. `restamp` fixes it.
 * - 'suspect': the audio timing looks normal but the video's length doesn't match it. That
 *   could be stretched video, or just audio that is shorter or longer than the video, so
 *   `restamp` leaves it alone unless called with `{ force: true }`.
 */
export type Analysis =
    | { status: "unsupported"; reason: string }
    | {
            status: "ok" | "broken" | "suspect";
            realSeconds: number; // true length, from the audio
            speedFactor: number; // claimed video length / real length; 1 when fine, 2 = plays 2x too slow
            video: VideoReport;
            audio: AudioReport;
      };

export interface RestampOptions {
    /** Also fix a 'suspect' file, trusting its audio length. */
    force?: boolean;
}

export interface RestampResult {
    analysis: Analysis;
    output: Uint8Array | null; // fixed file; null unless status is 'broken' (or 'suspect' with force)
}

export interface RestampFileResult {
    analysis: Analysis;
    output: Blob | null; // as RestampResult, built from slices of the input and the new header
}
