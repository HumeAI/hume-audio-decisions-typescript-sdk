// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { dataView, hasBytes, writeAscii } from "./bytes.js";
import { UnsupportedAudioError } from "./errors.js";

const CONVERT_COMMAND = "ffmpeg -i input.wav -c:a pcm_s16le output.wav";

const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;
const EXTENSIBLE = 0xfffe;
// An extensible header's subformat GUID is the format tag it stands for followed by these bytes.
const SUBFORMAT_GUID_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
// Writers that cannot seek back to fill in the size, such as ffmpeg writing to a pipe, leave this.
const UNKNOWN_SIZE = 0xffffffff;
const SAMPLE_WIDTHS: { readonly [tag: number]: readonly number[] | undefined } = {
    [PCM]: [1, 2, 3, 4],
    [IEEE_FLOAT]: [4, 8],
};
const EXTENSIBLE_FMT_BYTES = 40;

// Chunks are at least 1 ms long, so at this rate every chunk holds at least one sample.
const MIN_SAMPLE_RATE = 1000;
// The resampling filter grows with the sample rate, so without a limit a few bytes of header could
// demand gigabytes. No recording format in common use goes above this rate.
const MAX_SAMPLE_RATE = 768_000;

export interface WavAudio {
    /** The fmt chunk body written into every chunk. */
    readonly fmt: Uint8Array;
    readonly channels: number;
    /** The speaker of each channel, from an extensible header, or 0 when the header names none. */
    readonly channelMask: number;
    readonly sampleRate: number;
    /** Bytes in one sample of one channel. */
    readonly sampleWidth: number;
    readonly isFloat: boolean;
    readonly dataStart: number;
    readonly sampleCount: number;
    /** Bytes in one sample of every channel. */
    readonly frameBytes: number;
}

type Format = Omit<WavAudio, "dataStart" | "sampleCount">;

export function isWav(data: Uint8Array): boolean {
    return hasBytes(data, 0, "RIFF") || hasBytes(data, 0, "RF64");
}

export function parseWav(data: Uint8Array): WavAudio {
    if (hasBytes(data, 0, "RF64")) {
        throw unsupported("RF64 files are not supported");
    }
    if (data.length < 12 || !hasBytes(data, 0, "RIFF") || !hasBytes(data, 8, "WAVE")) {
        throw unsupported("no RIFF WAVE header");
    }
    const view = dataView(data);
    const riffSize = view.getUint32(4, true);
    let offset = 12;
    let format: Format | undefined;
    for (;;) {
        if (offset + 8 > data.length) {
            throw unsupported("no data chunk");
        }
        const isData = hasBytes(data, offset, "data");
        const isFmt = hasBytes(data, offset, "fmt ");
        let size = view.getUint32(offset + 4, true);
        offset += 8;
        if (isData) {
            if (format === undefined) {
                throw unsupported("the data chunk comes before the fmt chunk");
            }
            const available = data.length - offset;
            // Writers such as libsndfile fill in the sizes only when they close the file, so a recording
            // that was never closed declares no audio in a RIFF chunk that ends before it. Any other file
            // that declares no audio has none, including one whose RIFF size is unknown, because chunks
            // such as metadata can follow the data.
            const unclosed = size === 0 && 8 + riffSize <= offset;
            // A file cut short is read as far as it goes, up to its last whole sample.
            size = unclosed || size === UNKNOWN_SIZE ? available : Math.min(size, available);
            return { ...format, dataStart: offset, sampleCount: Math.floor(size / format.frameBytes) };
        }
        if (isFmt) {
            format = parseFormat(data.subarray(offset, offset + Math.min(size, EXTENSIBLE_FMT_BYTES)));
        }
        // Chunks with an odd size are followed by a padding byte.
        offset += size + (size % 2);
    }
}

/** Describes samples that start at offset 0 of their own buffer. */
export function samplesWav({
    channels,
    sampleRate,
    sampleWidth,
    isFloat,
    sampleCount,
}: Pick<WavAudio, "channels" | "sampleRate" | "sampleWidth" | "isFloat" | "sampleCount">): WavAudio {
    const fmt = fmtBody(
        isFloat ? IEEE_FLOAT : PCM,
        channels,
        sampleRate,
        sampleWidth,
        sampleWidth * 8,
        new Uint8Array(0),
    );
    return {
        fmt,
        channels,
        channelMask: 0,
        sampleRate,
        sampleWidth,
        isFloat,
        dataStart: 0,
        sampleCount,
        frameBytes: sampleWidth * channels,
    };
}

/** Builds a WAV file holding samples `start` to `end` and none of the source's other chunks. */
export function wavChunk(data: Uint8Array, wav: WavAudio, start: number, end: number): Uint8Array {
    const first = wav.dataStart + start * wav.frameBytes;
    const size = (end - start) * wav.frameBytes;
    const padding = size % 2;
    const headerBytes = 12 + 8 + wav.fmt.length + 8;
    const chunk = new Uint8Array(headerBytes + size + padding);
    const view = dataView(chunk);
    writeAscii(chunk, 0, "RIFF");
    view.setUint32(4, headerBytes - 8 + size + padding, true);
    writeAscii(chunk, 8, "WAVEfmt ");
    view.setUint32(16, wav.fmt.length, true);
    chunk.set(wav.fmt, 20);
    writeAscii(chunk, 20 + wav.fmt.length, "data");
    view.setUint32(24 + wav.fmt.length, size, true);
    chunk.set(data.subarray(first, first + size), headerBytes);
    return chunk;
}

function parseFormat(body: Uint8Array): Format {
    if (body.length < 16) {
        throw unsupported("the fmt chunk is too short");
    }
    const view = dataView(body);
    const headerTag = view.getUint16(0, true);
    const channels = view.getUint16(2, true);
    const sampleRate = view.getUint32(4, true);
    const blockAlign = view.getUint16(12, true);
    const bits = view.getUint16(14, true);
    let tag = headerTag;
    if (tag === EXTENSIBLE) {
        if (
            body.length < EXTENSIBLE_FMT_BYTES ||
            SUBFORMAT_GUID_SUFFIX.some((byte, index) => body[26 + index] !== byte)
        ) {
            throw unsupported("unknown extensible subformat");
        }
        tag = view.getUint16(24, true);
    }
    const widths = SAMPLE_WIDTHS[tag];
    if (widths === undefined) {
        throw unsupported(`format tag 0x${tag.toString(16).toUpperCase().padStart(4, "0")} is compressed or unknown`);
    }
    const sampleWidth = (bits + 7) >> 3;
    if (!widths.includes(sampleWidth) || (tag === IEEE_FLOAT && bits !== sampleWidth * 8)) {
        throw unsupported(`${bits}-bit ${tag === PCM ? "PCM" : "floating point"}`);
    }
    // Some writers leave the block size at 0 or 1, so it is recomputed for the chunks. A block larger
    // than one sample per channel means padded samples, which would be cut in the wrong places. The
    // recomputed block size must fit the header's 16 bits, and the byte rate its 32 bits.
    const frameBytes = sampleWidth * channels;
    if (channels < 1 || blockAlign > frameBytes || frameBytes > 0xffff || sampleRate * frameBytes > 0xffffffff) {
        throw unsupported("the fmt chunk is inconsistent");
    }
    if (sampleRate < MIN_SAMPLE_RATE) {
        throw unsupported(`${sampleRate} Hz is below the minimum of ${MIN_SAMPLE_RATE} Hz`);
    }
    if (sampleRate > MAX_SAMPLE_RATE) {
        throw unsupported(`${sampleRate} Hz is above the maximum of ${MAX_SAMPLE_RATE} Hz`);
    }
    const extension = headerTag === EXTENSIBLE ? body.subarray(16, EXTENSIBLE_FMT_BYTES) : new Uint8Array(0);
    const fmt = fmtBody(headerTag, channels, sampleRate, sampleWidth, bits, extension);
    const channelMask = headerTag === EXTENSIBLE ? view.getUint32(20, true) : 0;
    return { fmt, channels, channelMask, sampleRate, sampleWidth, isFloat: tag === IEEE_FLOAT, frameBytes };
}

function fmtBody(
    headerTag: number,
    channels: number,
    sampleRate: number,
    sampleWidth: number,
    bits: number,
    extension: Uint8Array,
): Uint8Array {
    const frameBytes = sampleWidth * channels;
    // Formats other than PCM declare the size of their header extension, which is empty here.
    const extensionBytes = headerTag === EXTENSIBLE ? extension.length : headerTag === PCM ? 0 : 2;
    const fmt = new Uint8Array(16 + extensionBytes);
    const view = dataView(fmt);
    view.setUint16(0, headerTag, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, sampleRate, true);
    view.setUint32(8, sampleRate * frameBytes, true);
    view.setUint16(12, frameBytes, true);
    view.setUint16(14, bits, true);
    if (headerTag === EXTENSIBLE) {
        fmt.set(extension, 16);
    }
    return fmt;
}

function unsupported(reason: string): UnsupportedAudioError {
    return new UnsupportedAudioError(
        `The audio is not a supported WAV file (${reason}). Convert it first, for example with: ${CONVERT_COMMAND}`,
    );
}
