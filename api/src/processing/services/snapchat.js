import { resolveRedirectingURL } from "../url.js";
import { genericUserAgent } from "../../config.js";
import { createStream } from "../../stream/manage.js";

const NEXT_DATA_REGEX = /<script id="__NEXT_DATA__" type="application\/json">({.+})<\/script><\/body><\/html>$/;
const NEXT_PUSH_REGEX = /self\.__next_f\.push\(\[\d,(.+?)\]\)/g;

async function getSpotlight(id) {
    const html = await fetch(`https://www.snapchat.com/spotlight/${id}`, {
        headers: { 'user-agent': genericUserAgent }
    }).then((r) => r.text()).catch(() => null);
    if (!html) {
        return { error: "fetch.fail" };
    }

    let data;
    for (const match of html.matchAll(NEXT_PUSH_REGEX)) {
        try {
            const [, rawFlightData] = match;
            if (!rawFlightData.includes("\"videoUrl\\\"")) continue;
            // parsing this is a bit tricky, but it always seems to start with 5: and then an actual array w/ data
            const dataMarker = rawFlightData.indexOf(":");
            if (dataMarker == -1) continue;

            const flightData = JSON.parse(JSON.parse("\"" + rawFlightData.slice(dataMarker + 1)));
            if (flightData[0] != "$") continue; // $ = REACT_ELEMENT_TYPE
            // [3] are the props AFAIK
            data = flightData[3]?.children?.[0]?.[3];
        } catch {}
    }

    if (!data) return;
    const videoURL = data?.video?.videoUrl;

    if (videoURL && new URL(videoURL).hostname.endsWith(".sc-cdn.net")) {
        return {
            urls: videoURL,
            filename: `snapchat_${id}.mp4`,
            audioFilename: `snapchat_${id}_audio`
        }
    }
}

async function getStory(username, storyId, alwaysProxy) {
    const html = await fetch(
        `https://www.snapchat.com/add/${username}${storyId ? `/${storyId}` : ''}`,
        { headers: { 'user-agent': genericUserAgent } }
    )
    .then((r) => r.text())
    .catch(() => null);

    if (!html) {
        return { error: "fetch.fail" };
    }

    const nextDataString = html.match(NEXT_DATA_REGEX)?.[1];
    if (nextDataString) {
        const data = JSON.parse(nextDataString);
        const storyIdParam = data?.query?.profileParams?.[1];

        if (storyIdParam && data?.props?.pageProps?.story) {
            const story = data.props.pageProps.story.snapList.find((snap) => snap.snapId.value === storyIdParam);
            if (story) {
                if (story.snapMediaType === 0) {
                    return {
                        urls: story.snapUrls.mediaUrl,
                        filename: `snapchat_${storyId}.jpg`,
                        isPhoto: true
                    }
                }

                return {
                    urls: story.snapUrls.mediaUrl,
                    filename: `snapchat_${storyId}.mp4`,
                    audioFilename: `snapchat_${storyId}_audio`
                }
            }
        }

        const defaultStory = data?.props?.pageProps?.curatedHighlights?.[0];
        if (defaultStory) {
            return {
                picker: defaultStory.snapList.map(snap => {
                    const snapType = snap.snapMediaType === 0 ? "photo" : "video";
                    const snapExt = snapType === "video" ? "mp4" : "jpg";
                    let snapUrl = snap.snapUrls.mediaUrl;

                    const proxy = createStream({
                        service: "snapchat",
                        type: "proxy",
                        url: snapUrl,
                        filename: `snapchat_${username}_${snap.timestampInSec.value}.${snapExt}`,
                    });

                    let thumbProxy;
                    if (snapType === "video") thumbProxy = createStream({
                        service: "snapchat",
                        type: "proxy",
                        url: snap.snapUrls.mediaPreviewUrl.value,
                    });

                    if (alwaysProxy) snapUrl = proxy;

                    return {
                        type: snapType,
                        url: snapUrl,
                        thumb: thumbProxy || proxy,
                    }
                })
            }
        }
    }
}

export default async function (obj) {
    let params = structuredClone(obj);
    if (params.shortLink?.startsWith("@")) {
        // actually contains a username
        params.username = params.shortLink.slice(1);
        delete params.shortLink;
    }

    if (params.shortLink) {
        params = await resolveRedirectingURL(`https://t.snapchat.com/${obj.shortLink}`);
    }

    if (params?.spotlightId) {
        const result = await getSpotlight(params.spotlightId);
        if (result) return result;
    } else if (params?.username) {
        const result = await getStory(params.username, params.storyId, obj.alwaysProxy);
        if (result) return result;
    }

    return { error: "fetch.fail" };
}
