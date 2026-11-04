// Fixes MP4/MOV files whose timestamps are stretched (seen on TikTok uploads: 60 fps
// footage labelled 30 fps, AAC packets claiming twice their real duration), by rewriting
// the moov sample tables. Header-only: nothing is decoded or re-encoded, and the media
// data stays byte-for-byte where it was.
//
// The evidence comes from the audio: an AAC packet always decodes to a fixed number of
// samples, so stretched audio timestamps give themselves away, and the audio's real length
// tells how far the video is stretched. Files that can't be fixed with confidence are
// reported as 'unsupported' or 'suspect' and left alone.
//
// Ported from https://github.com/georgerhaddad/video-restamp, which has the tests (run
// against synthetic broken and correct files), the details of how it works, and its
// limitations. Keep the two in sync.

import { inspect } from "./detect";
import { applyPlanToFile, inspectFile } from "./file";
import { applyPlan } from "./rewrite";
import type { Analysis, RestampFileResult, RestampOptions, RestampResult } from "./types";

export type * from "./types";

/** Reports whether the file's timestamps are stretched. Never throws. */
export function analyze(data: Uint8Array): Analysis {
    return inspect(data).analysis;
}

/**
 * Analyzes the file and returns a fixed copy if it is 'broken', or 'suspect' and
 * `options.force` is set. Never throws or modifies `data`.
 */
export function restamp(data: Uint8Array, options: RestampOptions = {}): RestampResult {
    const { analysis, plan } = inspect(data);
    if (!plan || !wanted(analysis, options)) return { analysis, output: null };
    try {
        return { analysis, output: applyPlan(data, plan) };
    } catch (error) {
        return { analysis: rewriteFailed(error), output: null };
    }
}

/**
 * Like `restamp`, for a file that may be too large to hold in memory, such as a `File` from
 * a file input or the origin private file system. Only the top-level box headers and the
 * moov box are read. The fixed copy is a Blob made of the new header and slices of `file`,
 * with the same content as `restamp` would return. Never throws or modifies `file`.
 */
export async function restampFile(file: Blob, options: RestampOptions = {}): Promise<RestampFileResult> {
    const { analysis, plan, moov } = await inspectFile(file);
    if (!plan || !moov || !wanted(analysis, options)) return { analysis, output: null };
    try {
        return { analysis, output: applyPlanToFile(file, moov, plan) };
    } catch (error) {
        return { analysis: rewriteFailed(error), output: null };
    }
}

/** A 'suspect' file is only fixed when forced. */
function wanted(analysis: Analysis, options: RestampOptions): boolean {
    return analysis.status !== "suspect" || !!options.force;
}

function rewriteFailed(error: unknown): Analysis {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "unsupported", reason: `The file couldn't be rewritten: ${reason}` };
}
