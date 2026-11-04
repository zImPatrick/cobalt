// AAC configuration: esds (ISO/IEC 14496-1 descriptors) and AudioSpecificConfig
// (ISO/IEC 14496-3, section 1.6.2.1). We only need to know how long each packet is.

import { findChild, payloadStart, readBoxes, readFullBox, type Box } from "./boxes";
import { Reader, UnsupportedError } from "./bytes";

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Audio object types whose core coder produces 1024 (or 960) samples per frame.
const AAC_CORE_TYPES: Record<number, string> = { 1: "AAC Main", 2: "AAC-LC", 3: "AAC SSR", 4: "AAC LTP" };
const SBR = 5;
const PS = 29;

export interface AacConfig {
    profile: string;
    coreSampleRate: number; // rate of the core AAC coder
    coreSamplesPerFrame: number; // 1024, or 960 with frameLengthFlag
    /** Output rate when SBR is signalled in the config; undefined when it isn't signalled. */
    sbrSampleRate: number | undefined;
    /** True when the config says outright that there is no SBR (sync extension, sbrPresentFlag 0). */
    sbrExcluded: boolean;
}

export function parseAudioSpecificConfig(bytes: Uint8Array): AacConfig {
    const bits = new BitReader(bytes);
    let objectType = readObjectType(bits);
    const coreSampleRate = readSampleRate(bits);
    const channelConfig = bits.read(4);
    let sbrSampleRate: number | undefined;
    let sbrExcluded = false;
    let ps = false;

    // Explicit hierarchical signalling: the outer type is SBR or PS, followed by the output
    // rate and the type of the core coder underneath.
    if (objectType === SBR || objectType === PS) {
        ps = objectType === PS;
        sbrSampleRate = readSampleRate(bits);
        objectType = readObjectType(bits);
    }

    const coreProfile = AAC_CORE_TYPES[objectType];
    if (!coreProfile) {
        throw new UnsupportedError(`This AAC variant (audio object type ${objectType}) isn't supported.`);
    }

    // GASpecificConfig
    const frameLengthFlag = bits.read(1);
    if (bits.read(1)) bits.read(14); // dependsOnCoreCoder -> coreCoderDelay
    bits.read(1); // extensionFlag; always 0 for these object types

    // Backward-compatible signalling: a sync extension after the core config may announce
    // SBR (0x2b7) and then PS (0x548). It can only be found when there is no
    // program_config_element (channelConfig 0), which we don't parse.
    if (sbrSampleRate === undefined && channelConfig !== 0 && bits.remaining >= 16 && bits.read(11) === 0x2b7) {
        if (readObjectType(bits) === SBR) {
            if (bits.read(1)) {
                sbrSampleRate = readSampleRate(bits);
                if (bits.remaining >= 12 && bits.read(11) === 0x548) ps = bits.read(1) === 1;
            } else {
                sbrExcluded = true;
            }
        }
    }

    let profile = coreProfile;
    if (sbrSampleRate !== undefined) profile = ps ? "HE-AACv2" : "HE-AAC";
    return {
        profile,
        coreSampleRate,
        coreSamplesPerFrame: frameLengthFlag ? 960 : 1024,
        sbrSampleRate,
        sbrExcluded
    };
}

/**
 * Reads the AAC config from an 'mp4a' sample entry. Throws UnsupportedError for
 * anything that isn't MPEG-4 AAC.
 */
export function readAacConfig(data: Uint8Array, entry: Box): AacConfig {
    if (entry.type !== "mp4a") {
        throw new UnsupportedError(`Only AAC audio is supported (this file has '${entry.type.trim()}').`);
    }
    // AudioSampleEntry: 8 bytes of SampleEntry, then a QuickTime-style version field.
    // Version 0 (and ISO) entries are 28 bytes; QuickTime versions 1 and 2 add 16 or 36.
    const reader = new Reader(data, payloadStart(entry), entry.end);
    reader.skip(8);
    const version = reader.u16();
    const entrySize = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : -1;
    if (entrySize < 0) throw new UnsupportedError("The audio sample description is not recognised.");
    const childStart = payloadStart(entry) + entrySize;
    if (childStart > entry.end) throw new UnsupportedError("The audio sample description is corrupt.");

    const children = readBoxes(data, childStart, entry.end);
    // QuickTime files may wrap the esds in a 'wave' box.
    const wave = children.find((box) => box.type === "wave");
    const esds = children.find((box) => box.type === "esds") ?? (wave && findChild(data, wave, "esds"));
    if (!esds) throw new UnsupportedError("The AAC track has no decoder configuration (esds).");
    return parseAudioSpecificConfig(readDecoderSpecificInfo(data, esds));
}

// MPEG-4 descriptor tags
const ES_DESCRIPTOR = 0x03;
const DECODER_CONFIG = 0x04;
const DECODER_SPECIFIC_INFO = 0x05;
// objectTypeIndication values meaning AAC: MPEG-4 audio, MPEG-2 AAC Main/LC/SSR
const AAC_OBJECT_TYPE_INDICATIONS = new Set([0x40, 0x66, 0x67, 0x68]);

function readDecoderSpecificInfo(data: Uint8Array, esds: Box): Uint8Array {
    const { reader } = readFullBox(data, esds);
    const es = readDescriptor(reader, ES_DESCRIPTOR);
    es.skip(2); // ES_ID
    const flags = es.u8();
    if (flags & 0x80) es.skip(2); // dependsOn_ES_ID
    if (flags & 0x40) es.skip(es.u8()); // URL
    if (flags & 0x20) es.skip(2); // OCR_ES_Id

    const config = readDescriptor(es, DECODER_CONFIG);
    const objectTypeIndication = config.u8();
    if (!AAC_OBJECT_TYPE_INDICATIONS.has(objectTypeIndication)) {
        throw new UnsupportedError("Only AAC audio is supported (this mp4a track is another codec, such as MP3).");
    }
    config.skip(1 + 3 + 4 + 4); // streamType, bufferSizeDB, maxBitrate, avgBitrate
    const info = readDescriptor(config, DECODER_SPECIFIC_INFO);
    return info.bytes(info.remaining);
}

/** Finds the next descriptor with `tag`, skipping others, and returns a reader over its body. */
function readDescriptor(reader: Reader, tag: number): Reader {
    while (reader.remaining > 0) {
        const found = reader.u8();
        // The size is 1-4 bytes of 7 bits each; the high bit means "another byte follows".
        let size = 0;
        for (let i = 0; i < 4; i++) {
            const byte = reader.u8();
            size = size * 128 + (byte & 0x7f);
            if (!(byte & 0x80)) break;
        }
        const body = reader.bytes(Math.min(size, reader.remaining));
        if (found === tag) return new Reader(body);
    }
    throw new UnsupportedError("The AAC decoder configuration is missing or corrupt.");
}

function readObjectType(bits: BitReader): number {
    const type = bits.read(5);
    return type === 31 ? 32 + bits.read(6) : type;
}

function readSampleRate(bits: BitReader): number {
    const index = bits.read(4);
    const rate = index === 0xf ? bits.read(24) : SAMPLE_RATES[index];
    if (!rate) throw new UnsupportedError("The AAC configuration has an invalid sample rate.");
    return rate;
}

class BitReader {
    private bytes: Uint8Array;
    private bit = 0;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }

    get remaining(): number {
        return this.bytes.length * 8 - this.bit;
    }

    read(count: number): number {
        if (count > this.remaining) {
            throw new UnsupportedError("The AAC configuration is truncated.");
        }
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byte = this.bytes[this.bit >> 3];
            value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
            this.bit++;
        }
        return value;
    }
}
