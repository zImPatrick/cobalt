import { get } from "svelte/store";
import { t } from "$lib/i18n/translations";
import { ffmpegMetadataArgs } from "$lib/util";
import { createDialog } from "$lib/state/dialogs";
import { addItem } from "$lib/state/task-manager/queue";
import { openQueuePopover } from "$lib/state/queue-visibility";
import { uuid } from "$lib/util";

import type { CobaltQueueItem, UUID } from "$lib/types/queue";
import type { CobaltCurrentTasks } from "$lib/types/task-manager";
import { resultFileTypes, type CobaltPipelineItem, type CobaltPipelineResultFileType } from "$lib/types/workers";
import type { CobaltLocalProcessingResponse, CobaltSaveRequestBody } from "$lib/types/api";

export const getMediaType = (type: string) => {
    const kind = type.split('/')[0] as CobaltPipelineResultFileType;

    if (resultFileTypes.includes(kind)) {
        return kind;
    }
}

// mp4 & mov files can be restamped, see lib/restamp
const restampExtensions = ["mp4", "mov", "m4v"];

export const createRemuxPipeline = (file: File) => {
    const parentId = uuid();
    const mediaType = getMediaType(file.type);
    const extension = file.name.split(".").pop()?.toLowerCase();

    const pipeline: CobaltPipelineItem[] = [];

    // fix stretched timestamps first, so that already downloaded
    // videos that play in slow motion can be fixed by remuxing them
    if (mediaType === "video" && extension && restampExtensions.includes(extension)) {
        pipeline.push({
            worker: "restamp",
            workerId: uuid(),
            parentId,
            workerArgs: {
                files: [file],
            },
        });
    }

    pipeline.push({
        worker: "remux",
        workerId: uuid(),
        parentId,
        dependsOn: pipeline.length ? [pipeline[0].workerId] : undefined,
        workerArgs: {
            files: pipeline.length ? [] : [file],
            ffargs: [
                "-c", "copy",
                "-map", "0"
            ],
            output: {
                type: file.type,
                format: file.name.split(".").pop(),
            },
        },
    });

    if (mediaType) {
        addItem({
            id: parentId,
            state: "waiting",
            pipeline,
            filename: file.name,
            mimeType: file.type,
            mediaType,
        });

        openQueuePopover();
    }
}

const makeRemuxArgs = (info: CobaltLocalProcessingResponse) => {
    const ffargs = ["-c:v", "copy"];

    if (["merge", "remux"].includes(info.type)) {
        ffargs.push("-c:a", "copy");
    } else if (info.type === "mute") {
        ffargs.push("-an");
    }

    if (info.output.subtitles) {
        ffargs.push(
            "-c:s",
            info.output.filename.endsWith(".mp4") ? "mov_text" : "webvtt"
        );
    }

    ffargs.push(
        ...(info.output.metadata ? ffmpegMetadataArgs(info.output.metadata) : [])
    );

    return ffargs;
}

const makeAudioArgs = (info: CobaltLocalProcessingResponse) => {
    if (!info.audio) {
        return;
    }

    const ffargs = [];

    if (info.audio.cover && info.audio.format === "mp3") {
        ffargs.push(
            "-map", "0",
            "-map", "1",
            // always encode cover to mjpeg for mp3 to ensure proper mimetype
            // this fixes "No mimetype is known for stream" errors
            "-c:v", "mjpeg",
            ...(info.audio.cropCover ? [
                "-vf", "scale=-1:720,crop=720:720",
            ] : []),
        );
    } else {
        ffargs.push("-vn");
    }

    ffargs.push(
        ...(info.audio.copy ? ["-c:a", "copy"] : ["-b:a", `${info.audio.bitrate}k`]),
        ...(info.output.metadata ? ffmpegMetadataArgs(info.output.metadata) : [])
    );

    if (info.audio.format === "mp3" && info.audio.bitrate === "8") {
        ffargs.push("-ar", "12000");
    }

    if (info.audio.format === "opus") {
        ffargs.push("-vbr", "off")
    }

    const outFormat = info.audio.format === "m4a" ? "ipod" : info.audio.format;

    ffargs.push('-f', outFormat);
    return ffargs;
}

const makeGifArgs = () => {
    return [
        "-vf",
        "scale=-1:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        "-loop", "0",
        "-f", "gif"
    ];
}

const showError = (errorCode: string) => {
    return createDialog({
        id: "pipeline-error",
        type: "small",
        meowbalt: "error",
        buttons: [
            {
                text: get(t)("button.gotit"),
                main: true,
                action: () => {},
            },
        ],
        bodyText: get(t)(`error.${errorCode}`),
    });
}

export const createSavePipeline = (
    info: CobaltLocalProcessingResponse,
    request: CobaltSaveRequestBody,
    oldTaskId?: string
) => {
    // this is a pre-queue part of processing,
    // so errors have to be returned via a regular dialog

    if (!info.output?.filename || !info.output?.type) {
        return showError("pipeline.missing_response_data");
    }

    const parentId = oldTaskId || uuid();
    const pipeline: CobaltPipelineItem[] = [];

    // some tiktok videos have stretched timestamps, so they play in slow motion
    // against normal speed audio on desktop. restamp fixes that by rewriting only
    // the mp4 header, and passes files that are fine (or that it can't fix) through
    const restamp = info.service === "tiktok" && info.output.filename.endsWith(".mp4");

    const addRestamp = (dependsOn: UUID) => {
        const workerId = uuid();

        pipeline.push({
            worker: "restamp",
            workerId,
            parentId,
            dependsOn: [dependsOn],
            workerArgs: {
                files: [],
            },
        });

        return workerId;
    }

    // reverse is needed for audio (second item) to be downloaded first
    const tunnels = info.tunnel.reverse();

    for (const tunnel of tunnels) {
        pipeline.push({
            worker: "fetch",
            workerId: uuid(),
            parentId,
            workerArgs: {
                url: tunnel,
            },
        });
    }

    if (info.type !== "proxy") {
        let ffargs: string[];
        let workerType: 'encode' | 'remux';

        if (["merge", "mute", "remux"].includes(info.type)) {
            workerType = "remux";
            ffargs = makeRemuxArgs(info);
        } else if (info.type === "audio") {
            const args = makeAudioArgs(info);

            if (!args) {
                return showError("pipeline.missing_response_data");
            }

            workerType = "encode";
            ffargs = args;
        } else if (info.type === "gif") {
            workerType = "encode";
            ffargs = makeGifArgs();
        } else {
            console.error("unknown work type: " + info.type);
            return showError("pipeline.missing_response_data");
        }

        const output = {
            type: info.output.type,
            format: info.output.filename.split(".").pop(),
        };

        let dependsOn = pipeline.map(w => w.workerId);

        if (restamp && info.type === "mute" && dependsOn.length === 1) {
            // muting removes the audio that restamp needs, so fix the video first
            dependsOn = [addRestamp(dependsOn[0])];
        } else if (restamp && info.type === "remux" && info.output.subtitles) {
            // restamp can't handle files with a subtitle track, so fix the video before
            // subtitles are added to it. tunnels are reversed above: subtitles come first
            const [subtitles, ...media] = dependsOn;
            let video = media[media.length - 1];

            // h265 dash: the video stream has no audio to restamp against,
            // so merge it with the audio first and add subtitles afterwards
            if (media.length > 1) {
                video = uuid();

                pipeline.push({
                    worker: "remux",
                    workerId: video,
                    parentId,
                    dependsOn: media,
                    workerArgs: {
                        files: [],
                        ffargs: ["-c:v", "copy", "-c:a", "copy"],
                        output,
                    },
                });
            }

            dependsOn = [subtitles, addRestamp(video)];
        }

        pipeline.push({
            worker: workerType,
            workerId: uuid(),
            parentId,
            dependsOn,
            workerArgs: {
                files: [],
                ffargs,
                output,
            },
        });
    }

    // the browser merge keeps stretched timestamps, so fix the merged file
    if (restamp && (info.type === "proxy" || info.type === "merge")) {
        addRestamp(pipeline[pipeline.length - 1].workerId);
    }

    addItem({
        id: parentId,
        state: "waiting",
        pipeline,
        canRetry: true,
        originalRequest: request,
        filename: info.output.filename,
        mimeType: info.output.type,
        mediaType: getMediaType(info.output.type) || "file",
    });

    openQueuePopover();
}

export const getProgress = (item: CobaltQueueItem, currentTasks: CobaltCurrentTasks): number => {
    if (item.state === 'done' || item.state === 'error') {
        return 1;
    } else if (item.state === 'waiting') {
        return 0;
    }

    let sum = 0;
    for (const worker of item.pipeline) {
        if (item.pipelineResults[worker.workerId]) {
            sum += 1;
        } else {
            const task = currentTasks[worker.workerId];
            sum += (task?.progress?.percentage || 0) / 100;
        }
    }

    return sum / item.pipeline.length;
}
