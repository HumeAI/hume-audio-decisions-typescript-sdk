// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { hasBytes, uint32BE } from "./bytes.js";
import { UnsupportedAudioError } from "./errors.js";

const CONVERT_COMMAND = "ffmpeg -i input.mp3 -c:a libmp3lame -q:a 2 output.mp3";

// Keyed by the version bits of a frame header. Version 1 is reserved.
const SAMPLE_RATES: { readonly [version: number]: readonly number[] | undefined } = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000],
};
const MPEG1 = 3;
// Layer III bitrates in kbit/s. Index 0 is free format.
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const LAYER_III = 1;
const MONO = 3;
// Samples a layer III decoder outputs before the first sample the encoder was given.
const DECODER_DELAY = 529;
// Encoders whose header frame carries a LAME tag, which states the samples added at each end.
const LAME_TAG_ENCODERS = ["LAME", "Lavf", "Lavc"];
// Tags that some writers append after the last frame. Nothing after one is audio.
const TRAILING_TAGS = ["TAG", "APETAGEX", "LYRICSBEGIN", "ID3"];

interface Header {
    readonly version: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly length: number;
    /**
     * Bytes from the start of the frame to its side information, which follows the header and an
     * optional checksum.
     */
    readonly sideInfoStart: number;
    readonly sideInfoSize: number;
}

interface HeaderFrame {
    readonly leadingSamples: number;
    readonly trailingSamples: number;
    readonly statedFrames: number | undefined;
}

const NO_HEADER_FRAME: HeaderFrame = { leadingSamples: 0, trailingSamples: 0, statedFrames: undefined };

export interface Mp3Audio {
    readonly sampleRate: number;
    /** The most channels any audio frame has, since each frame states its own. 0 without frames. */
    readonly channels: number;
    readonly samplesPerFrame: number;
    /** Where each frame starts, followed by where the last one ends. Frames are contiguous. */
    readonly offsets: readonly number[];
    /** For each frame, how many bytes of its audio data are stored in the frames before it. */
    readonly reservoirBytes: readonly number[];
    /** For each frame, how many bytes of audio data, its own or later frames', it holds itself. */
    readonly mainDataBytes: readonly number[];
    /**
     * Samples decoded from the frames before the recording starts, which players leave out when a
     * LAME tag states them. 0 without one.
     */
    readonly leadingSamples: number;
    readonly frameCount: number;
    /** The sample after the recording's last, counted from the start of the first frame. */
    readonly endSample: number;
}

export function isMp3(data: Uint8Array): boolean {
    return hasBytes(data, 0, "ID3") || hasFrameSync(data, 0);
}

export function parseMp3(data: Uint8Array): Mp3Audio {
    let offset = skipId3v2(data);
    const first = readHeader(data, offset);
    // The first frame can be a Xing, Info or VBRI header, which holds the length of the whole file
    // instead of audio. Left in a chunk, it would tell players the chunk is that long.
    const headerFrame = offset + first.length <= data.length ? readHeaderFrame(data, offset, first) : undefined;
    if (headerFrame !== undefined) {
        offset += first.length;
    }
    const offsets: number[] = [];
    const reservoirBytes: number[] = [];
    const mainDataBytes: number[] = [];
    let channels = 0;
    while (offset + 4 <= data.length && !startsTrailingTag(data, offset)) {
        const header = tryReadHeader(data, offset);
        if (typeof header === "string") {
            // Players skip bytes after the last frame that are neither a frame nor a tag, such as
            // padding. When frames follow them, the bytes are damage instead.
            if (framesFollow(data, offset + 1, first)) {
                throw unsupported(header);
            }
            break;
        }
        if (header.version !== first.version || header.sampleRate !== first.sampleRate) {
            throw unsupported(`the sample rate changes at byte ${offset}`);
        }
        // A file cut short is read up to its last whole frame.
        if (offset + header.length > data.length) {
            break;
        }
        channels = Math.max(channels, header.channels);
        offsets.push(offset);
        reservoirBytes.push(readReservoirBytes(data, offset, header));
        mainDataBytes.push(header.length - header.sideInfoStart - header.sideInfoSize);
        offset += header.length;
    }
    offsets.push(offset);
    const frameCount = offsets.length - 1;
    const { leadingSamples, trailingSamples, statedFrames } = headerFrame ?? NO_HEADER_FRAME;
    const samplesPerFrame = first.version === MPEG1 ? 1152 : 576;
    return {
        sampleRate: first.sampleRate,
        channels,
        samplesPerFrame,
        offsets,
        reservoirBytes,
        mainDataBytes,
        leadingSamples,
        frameCount,
        // The samples added at the end close the frames the header counts. A file cut short has lost
        // them, and players then leave nothing out at the end.
        endSample: frameCount * samplesPerFrame - (statedFrames === frameCount ? trailingSamples : 0),
    };
}

/** Counts the frames that must come before `frame` in a chunk for it to decode exactly. */
export function framesNeededBefore(mp3: Mp3Audio, frame: number): number {
    if (frame === 0) {
        return 0;
    }
    // Each frame's output is blended with the end of the previous frame's, so the previous frame
    // must decode exactly too, and so needs its own stored audio data.
    return Math.max(framesHoldingDataOf(mp3, frame), 1 + framesHoldingDataOf(mp3, frame - 1));
}

/** Builds an MP3 file holding frames `start` to `end` and none of the source's tags. */
export function mp3Chunk(data: Uint8Array, mp3: Mp3Audio, start: number, end: number): Uint8Array {
    // Copied rather than sliced, since a Buffer's slice is a view that would keep the whole recording.
    return new Uint8Array(data.subarray(mp3.offsets[start], mp3.offsets[end]));
}

function framesHoldingDataOf(mp3: Mp3Audio, frame: number): number {
    let needed = mp3.reservoirBytes[frame];
    if (needed === 0) {
        return 0;
    }
    let count = 0;
    while (needed > 0 && count < frame) {
        count += 1;
        needed -= mp3.mainDataBytes[frame - count];
    }
    // Decoders such as ffmpeg and mpg123 do not keep the audio data of the first frame they read
    // when they cannot decode it, so the data must start after the chunk's first frame.
    return Math.min(count + 1, frame);
}

function hasFrameSync(data: Uint8Array, offset: number): boolean {
    return offset + 2 <= data.length && data[offset] === 0xff && (data[offset + 1] & 0xe0) === 0xe0;
}

function startsTrailingTag(data: Uint8Array, offset: number): boolean {
    return TRAILING_TAGS.some((tag) => hasBytes(data, offset, tag));
}

function readReservoirBytes(data: Uint8Array, offset: number, header: Header): number {
    // Layer III frames may store audio data in the unused space of the frames before them. The side
    // information starts with how far back that data begins: 9 bits in MPEG-1 and 8 bits otherwise.
    const sideInfo = offset + header.sideInfoStart;
    if (header.version === MPEG1) {
        return (data[sideInfo] << 1) | (data[sideInfo + 1] >> 7);
    }
    return data[sideInfo];
}

function skipId3v2(data: Uint8Array): number {
    let offset = 0;
    while (hasBytes(data, offset, "ID3") && offset + 10 <= data.length) {
        const flags = data[offset + 5];
        // ID3v2 sizes store 7 bits in each byte.
        let size = 0;
        for (let index = offset + 6; index < offset + 10; index++) {
            size = (size << 7) | (data[index] & 0x7f);
        }
        offset += 10 + size + (flags & 0x10 ? 10 : 0);
    }
    return offset;
}

function readHeader(data: Uint8Array, offset: number): Header {
    const header = tryReadHeader(data, offset);
    if (typeof header === "string") {
        throw unsupported(header);
    }
    return header;
}

/** The frame header at `offset`, or the reason there is none. */
function tryReadHeader(data: Uint8Array, offset: number): Header | string {
    if (offset + 4 > data.length) {
        return "no MPEG audio frame";
    }
    if (!hasFrameSync(data, offset)) {
        return `no MPEG audio frame at byte ${offset}`;
    }
    const b1 = data[offset + 1];
    const b2 = data[offset + 2];
    const b3 = data[offset + 3];
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = b2 >> 4;
    const sampleRateIndex = (b2 >> 2) & 3;
    const sampleRates = SAMPLE_RATES[version];
    if (sampleRates === undefined || layer === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
        return `invalid frame header at byte ${offset}`;
    }
    if (layer !== LAYER_III) {
        return "MPEG layer I and II audio is not supported";
    }
    if (bitrateIndex === 0) {
        return "free format MP3 files are not supported";
    }
    const mpeg1 = version === MPEG1;
    const sampleRate = sampleRates[sampleRateIndex];
    const bitrate = (mpeg1 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex];
    const length = Math.floor(((mpeg1 ? 144000 : 72000) * bitrate) / sampleRate) + ((b2 >> 1) & 1);
    const mono = b3 >> 6 === MONO;
    const sideInfoSize = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    // A protection bit of 0 means a 16-bit checksum follows the header.
    const sideInfoStart = b1 & 1 ? 4 : 6;
    if (length < sideInfoStart + sideInfoSize) {
        return `invalid frame header at byte ${offset}`;
    }
    return { version, sampleRate, channels: mono ? 1 : 2, length, sideInfoStart, sideInfoSize };
}

/**
 * Reads a Xing, Info or VBRI header frame: the samples added before and after the recording, and
 * the frame count it states. Undefined when the frame holds audio instead.
 */
function readHeaderFrame(data: Uint8Array, offset: number, header: Header): HeaderFrame | undefined {
    // Fields that would run past the end of the frame are absent, not read from the next frame.
    const frame = data.subarray(offset, offset + header.length);
    // Encoders place the Xing tag after the side information as if the frame had no checksum.
    const xing = 4 + header.sideInfoSize;
    if (!hasBytes(frame, xing, "Xing") && !hasBytes(frame, xing, "Info")) {
        return hasBytes(frame, 36, "VBRI") ? NO_HEADER_FRAME : undefined;
    }
    const flags = uint32BE(frame, xing + 4) ?? 0;
    let position = xing + 8;
    let statedFrames: number | undefined;
    if (flags & 1) {
        statedFrames = uint32BE(frame, position);
        position += 4;
    }
    // The byte count, table of contents and quality follow when their flags are set.
    position += (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
    if (position + 24 > frame.length || !LAME_TAG_ENCODERS.some((encoder) => hasBytes(frame, position, encoder))) {
        return { leadingSamples: 0, trailingSamples: 0, statedFrames };
    }
    // Two 12-bit counts after the encoder's name and other settings: the samples the encoder added
    // before the recording, and after it. The decoder's own delay precedes both.
    const b0 = frame[position + 21];
    const b1 = frame[position + 22];
    const b2 = frame[position + 23];
    const delay = (b0 << 4) | (b1 >> 4);
    const padding = ((b1 & 0x0f) << 8) | b2;
    return {
        leadingSamples: delay + DECODER_DELAY,
        trailingSamples: Math.max(0, padding - DECODER_DELAY),
        statedFrames,
    };
}

/** Whether two frames in a row, of the same version and sample rate as `first`, start at or after `offset`. */
function framesFollow(data: Uint8Array, offset: number, first: Header): boolean {
    // Requiring two frames in a row keeps bytes that happen to look like a frame header from counting.
    let position = data.indexOf(0xff, offset);
    while (position !== -1) {
        const header = matchingHeader(data, position, first);
        if (header !== undefined && matchingHeader(data, position + header.length, first) !== undefined) {
            return true;
        }
        position = data.indexOf(0xff, position + 1);
    }
    return false;
}

function matchingHeader(data: Uint8Array, offset: number, first: Header): Header | undefined {
    const header = tryReadHeader(data, offset);
    if (typeof header === "string") {
        return undefined;
    }
    return header.version === first.version && header.sampleRate === first.sampleRate ? header : undefined;
}

function unsupported(reason: string): UnsupportedAudioError {
    return new UnsupportedAudioError(
        `The audio is not a supported MP3 file (${reason}). Convert it first, for example with: ${CONVERT_COMMAND}`,
    );
}
