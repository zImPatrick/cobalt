import { genericUserAgent } from "../../config.js";
import crypto from "node:crypto";

const solveGuard = async () => {
    const countLeadingZeros = (buffer) => {
        let count = 0;
        for (const b of buffer) {
            if (b == 0) {
                count += 8;
            } else {
                count += Math.clz32(b) - 24;
                break;
            }
        }

        return count;
    }
    const json = await fetch("https://www.newgrounds.com/_guard/v1/challenge", {
        headers: {
            "User-Agent": genericUserAgent,
            "X-Requested-With": "XMLHttpRequest"
        }
    }).then(r => r.json());

    const { payload, sig, bits } = json;

    const challenge = Buffer.from(payload, "base64");
    const workingBuffer = Buffer.alloc(challenge.length + 20 + 1);
    challenge.copy(workingBuffer, 0);
    Buffer.from(":", "utf-8").copy(workingBuffer, challenge.length);

    let nonce;
    for (let i = 0; true; i++) {
        const encodedNum = Buffer.from(i.toString(), "utf-8");
        workingBuffer.set(encodedNum, challenge.length + 1);

        const sha = crypto.hash("SHA-256", workingBuffer.subarray(0, challenge.length + 1 + encodedNum.length), "buffer");
        if (countLeadingZeros(sha) >= bits) {
            nonce = i;
            break;
        }
    }

    const verifyResponse = await fetch("https://www.newgrounds.com/_guard/v1/verify", {
        headers: {
            "User-Agent": genericUserAgent,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/json"
        },
        method: "POST",
        body: JSON.stringify({
            bits,
            nonce,
            payload,
            sig,
            demo: false
        })
    }).then(r => r.json());

    if (!verifyResponse.ok) {
        throw new Error("couldn't pass PoW check");
    }
}

const getVideo = async ({ id, quality }) => {
    const text = await fetch(`https://www.newgrounds.com/portal/video/${id}`, {
        headers: {
            "User-Agent": genericUserAgent,
            "X-Requested-With": "XMLHttpRequest", // required to get the JSON response
        }
    }).then(r => r.text()).catch(() => {});

    if (!text) {
        return { error: "fetch.fail" };
    }

    if (text.includes("<title>NG Guard</title>")) {
        try {
            await solveGuard();
        } catch {
            return { error: "fetch.fail" };
        }

        return await getVideo({ id, quality });
    }

    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return { error: "fetch.empty" };
    }

    const videoSources = json.sources;
    const videoQualities = Object.keys(videoSources);

    if (videoQualities.length === 0) {
        return { error: "fetch.empty" };
    }

    const bestVideo = videoSources[videoQualities[0]]?.[0],
          userQuality = quality === "2160" ? "4k" : `${quality}p`,
          preferredVideo = videoSources[userQuality]?.[0],
          video = preferredVideo || bestVideo,
          videoQuality = preferredVideo ? userQuality : videoQualities[0];

    if (!bestVideo || !video.type.includes("mp4")) {
        return { error: "fetch.empty" };
    }

    const fileMetadata = {
        title: decodeURIComponent(json.title),
        artist: decodeURIComponent(json.author),
    }

    return {
        urls: video.src,
        filenameAttributes: {
            service: "newgrounds",
            id,
            title: fileMetadata.title,
            author: fileMetadata.artist,
            extension: "mp4",
            qualityLabel: videoQuality,
            resolution: videoQuality,
        },
        fileMetadata,
    }
}

const getMusic = async ({ id }) => {
    const html = await fetch(`https://www.newgrounds.com/audio/listen/${id}`, {
        headers: {
            "User-Agent": genericUserAgent,
        }
    })
    .then(r => r.text())
    .catch(() => {});

    if (!html) return { error: "fetch.fail" };
    
    if (html?.includes("<title>NG Guard</title>")) {
        await solveGuard();
        return await getMusic({ id });
    }

    const params = JSON.parse(
        `{${html.split(',"params":{')[1]?.split(',"images":')[0]}}`
    );
    if (!params) return { error: "fetch.empty" };

    if (!params.name || !params.artist || !params.filename || !params.icon) {
        return { error: "fetch.empty" };
    }

    const fileMetadata = {
        title: decodeURIComponent(params.name),
        artist: decodeURIComponent(params.artist),
    }

    return {
        urls: params.filename,
        filenameAttributes: {
            service: "newgrounds",
            id,
            title: fileMetadata.title,
            author: fileMetadata.artist,
        },
        fileMetadata,
        cover:
            params.icon.includes(".png?") || params.icon.includes(".jpg?")
                ? params.icon
                : undefined,
        isAudioOnly: true,
        bestAudio: "mp3",
    }
}

export default function({ id, audioId, quality }) {
    if (id) {
        return getVideo({ id, quality });
    } else if (audioId) {
        return getMusic({ id: audioId });
    }

    return { error: "fetch.empty" };
}
