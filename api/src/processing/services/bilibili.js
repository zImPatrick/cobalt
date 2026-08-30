import { env } from "../../config.js";
import { resolveRedirectingURL } from "../url.js";
import { hash } from "node:crypto";

// TO-DO: higher quality downloads (currently requires an account)

let captchaCookie;
let captchaPromise;

function getHeaders(bvid) {
    const headers = {
        "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    };
    if (bvid) headers["referer"] = `https://www.bilibili.com/video/${bvid}/`;
    if (captchaCookie) headers["cookie"] = captchaCookie;

    return headers;
}

function getBest(content) {
    return content?.filter(v => v.baseUrl || v.url)
                .map(v => (v.baseUrl = v.baseUrl || v.url, v))
                .reduce((a, b) => a?.bandwidth > b?.bandwidth ? a : b);
}

function extractBestQuality(dashData) {
    const bestVideo = getBest(dashData.video),
          bestAudio = getBest(dashData.audio);

    if (!bestVideo || !bestAudio) return [];
    return [ bestVideo, bestAudio ];
}

function extractStreamDataFromHTML(html) {
    const rawStreamData = html.split('<script>window.__playinfo__=')[1]?.split('</script>')[0];
    if (!rawStreamData) return;

    const data = JSON.parse(rawStreamData);
    if (data.code !== 0) return;

    return data; 
}

async function fetchStreamDataFromAPI(html) {
    // initial state has required aid and cid (bvid doesn't seem to be required)
    const initialStateHtml = html.split('<script>window.__INITIAL_STATE__=')[1]?.split(';(function()')[0];
    if (!initialStateHtml) return;
    const { aid, bvid, cid } = JSON.parse(initialStateHtml);
    
    const params = new URLSearchParams({
        aid,
        bvid,
        cid,
        fnval: 4048, // unlocks higher qualities
    })

    const playinfo = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${params.toString()}`, {
        headers: getHeaders(bvid),
    }).then(r => r.json()).catch(() => {});
    if (!playinfo || playinfo.code !== 0) return;
    
    return playinfo;
}

function pow(tokenQ, tokenR) {
    for (let i = 0; i < 5_000_000; i++) {
        const h = hash("SHA-256", tokenQ + i);
        if (h == tokenR) {
            return i;
        }
    }
}
/**
 * @param {Response} response
 */
async function solveCaptcha(response) {
    const secTokenCookie = response.headers.getSetCookie()
        .find(v => v.startsWith("X-BILI-SEC-TOKEN"));
    
    if (!secTokenCookie) throw new Error("Unable to find sec token");
    
    const cookieParts = secTokenCookie.split("=")?.[1].split(";")[0].split(",");
    if (cookieParts.length != 2) throw new Error("Unexpected number of parts in sec token");

    const [ cookieChallengeType, jwt ] = cookieParts;
    // at least I think its some sort of challenge type
    // their JS also only implements "3"
    if (cookieChallengeType !== "3") throw new Error(`Unknown challenge type ${cookieChallengeType}`);

    const jwtPayload = JSON.parse(atob(jwt.split(".")[1]));

    const { q, r, type, verity, exp } = jwtPayload;
    if (verity !== 0) throw new Error(`Unknown token verity ${verity}`);
    if (type !== "1") throw new Error(`Unknown token type ${type}`);

    const solution = pow(q, r);
    
    // submit solution
    const solutionResponse = await fetch("https://security.bilibili.com/th/captcha/cc/check", {
        method: "POST",
        body: new URLSearchParams({
            token: jwt,
            result: solution,
        }).toString(),
        headers: {
            ...getHeaders(),
            "Content-Type": "application/x-www-form-urlencoded",
        }
    });
    if (!solutionResponse.ok) throw new Error(`Error while submitting solution: ${solutionResponse.status}`);
    
    const { code, message } = await solutionResponse.json();
    if (code !== 0) throw new Error(`Invalid code: ${code}`);

    captchaCookie = "X-BILI-SEC-TOKEN=" + message;
}

async function com_download(id, partId) {
    const url = new URL(`https://www.bilibili.com/video/${id}/`);

    if (partId) {
        url.searchParams.set('p', partId);
    }

    const response = await fetch(url, {
        headers: getHeaders(id),
    }).catch(() => {});

    const html = await response?.text().catch(() => {});

    if (!html) {
        return { error: "fetch.fail" }
    }
    
    if (response.status == 412) {
        // we either need to solve their pow or just refresh
        try {
            if (captchaPromise) await captchaPromise;
            else captchaPromise = await solveCaptcha(response);
        } catch {
            return { error: "fetch.fail" };
        } finally {
            captchaPromise = null;
        }

        return await com_download(id, partId);
    }

    let streamData = extractStreamDataFromHTML(html)
        ?? await fetchStreamDataFromAPI(html);

    if (!streamData) {
        return { error: "fetch.empty" };
    }

    if (streamData.data.timelength > env.durationLimit * 1000) {
        return { error: "content.too_long" };
    }

    const [ video, audio ] = extractBestQuality(streamData.data.dash);
    if (!video || !audio) {
        return { error: "fetch.empty" };
    }

    let filenameBase = `bilibili_${id}`;
    if (partId) {
        filenameBase += `_${partId}`;
    }

    return {
        urls: [video.baseUrl, audio.baseUrl],
        audioFilename: `${filenameBase}_audio`,
        filename: `${filenameBase}_${video.width}x${video.height}.mp4`,
    };
}

async function tv_download(id) {
    const url = new URL(
        'https://api.bilibili.tv/intl/gateway/web/playurl'
        + '?s_locale=en_US&platform=web&qn=64&type=0&device=wap'
        + '&tf=0&spm_id=bstar-web.ugc-video-detail.0.0&from_spm_id='
    );

    url.searchParams.set('aid', id);

    const { data } = await fetch(url).then(a => a.json());
    if (!data?.playurl?.video) {
        return { error: "fetch.empty" };
    }

    const [ video, audio ] = extractBestQuality({
        video: data.playurl.video.map(s => s.video_resource)
                                 .filter(s => s.codecs.includes('avc1')),
        audio: data.playurl.audio_resource
    });

    if (!video || !audio) {
        return { error: "fetch.empty" };
    }

    if (video.duration > env.durationLimit * 1000) {
        return { error: "content.too_long" };
    }

    return {
        urls: [video.url, audio.url],
        audioFilename: `bilibili_tv_${id}_audio`,
        filename: `bilibili_tv_${id}.mp4`
    };
}

export default async function({ comId, tvId, comShortLink, partId }) {
    if (comShortLink) {
        const patternMatch = await resolveRedirectingURL(`https://b23.tv/${comShortLink}`);
        comId = patternMatch?.comId;
    }

    if (comId) {
        return com_download(comId, partId);
    } else if (tvId) {
        return tv_download(tvId);
    }

    return { error: "fetch.fail" };
}
