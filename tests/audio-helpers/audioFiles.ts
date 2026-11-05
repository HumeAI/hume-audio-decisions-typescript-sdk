// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { readFileSync } from "fs";
import { join } from "path";

const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;
const EXTENSIBLE = 0xfffe;
const SUBFORMAT_GUID_SUFFIX = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
    const collected: T[] = [];
    for await (const item of items) {
        collected.push(item);
    }
    return collected;
}

/** The error that iterating `items` throws. */
export async function iterationError(items: AsyncIterable<unknown>): Promise<Error> {
    try {
        await collect(items);
    } catch (error) {
        return error as Error;
    }
    throw new Error("Iteration did not throw.");
}

/** The error that `promise` rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error("The promise did not reject.");
}

/** The error that `action` throws. */
export function thrownBy(action: () => unknown): Error {
    try {
        action();
    } catch (error) {
        return error as Error;
    }
    throw new Error("The action did not throw.");
}

/** Checks the error's exact class, so that a plain Error does not pass for a RangeError or the reverse. */
export function expectError(error: Error, type: new (message: string) => Error, message: string): void {
    expect(error.constructor).toBe(type);
    expect(error.message).toContain(message);
}

/** Compares bytes with Buffer.compare, because toEqual compares a recording slowly, one byte at a time. */
export function expectBytes(actual: readonly Uint8Array[], expected: readonly Uint8Array[]): void {
    expect(actual.map((bytes, index) => Buffer.compare(bytes, expected[index]))).toEqual(expected.map(() => 0));
}

export function times(chunks: readonly { startMs: number; endMs: number }[]): [number, number][] {
    return chunks.map((chunk) => [chunk.startMs, chunk.endMs]);
}

/** A recording from the assets directory, in a buffer of its own. */
export function asset(name: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(readFileSync(join(__dirname, "assets", name)));
}

export function bytes(...parts: (Uint8Array | string | number[])[]): Uint8Array<ArrayBuffer> {
    const encoded = parts.map((part) =>
        typeof part === "string" ? Uint8Array.from(part, (char) => char.charCodeAt(0)) : Uint8Array.from(part),
    );
    const joined = new Uint8Array(encoded.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of encoded) {
        joined.set(part, offset);
        offset += part.length;
    }
    return joined;
}

export function uint16(value: number): Uint8Array {
    return bytes([value & 0xff, (value >> 8) & 0xff]);
}

export function uint32(value: number): Uint8Array {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, value, true);
    return data;
}

/** Bytes that differ for each size, the same on every run. */
export function pcm(size: number): Uint8Array<ArrayBuffer> {
    let state = size;
    const data = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data[index] = state >>> 24;
    }
    return data;
}

/**
 * A WAV file holding `data`, samples already in the given format, with a basic header, or an extensible
 * one when `channelMask` is given.
 */
export function wavFile({
    data,
    sampleRate,
    channels,
    sampleWidth = 2,
    isFloat = false,
    channelMask,
}: {
    data: Uint8Array;
    sampleRate: number;
    channels: number;
    sampleWidth?: number;
    isFloat?: boolean;
    channelMask?: number;
}): Uint8Array<ArrayBuffer> {
    const frameBytes = sampleWidth * channels;
    const tag = isFloat ? IEEE_FLOAT : PCM;
    let fmt = bytes(
        uint16(channelMask === undefined ? tag : EXTENSIBLE),
        uint16(channels),
        uint32(sampleRate),
        uint32(sampleRate * frameBytes),
        uint16(frameBytes),
        uint16(sampleWidth * 8),
    );
    if (channelMask !== undefined) {
        fmt = bytes(fmt, uint16(22), uint16(sampleWidth * 8), uint32(channelMask), uint16(tag), SUBFORMAT_GUID_SUFFIX);
    }
    const body = bytes("WAVE", "fmt ", uint32(fmt.length), fmt, "data", uint32(data.length), data);
    return bytes("RIFF", uint32(body.length), body);
}

// MPEG-1 layer III bitrates in kbit/s and sample rates, by their index in a frame header.
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];

/** Builds an ID3v2.4 tag holding `contents`, or that many zero bytes. */
export function id3v2(contents: Uint8Array | number, { footer = false }: { footer?: boolean } = {}): Uint8Array {
    const body = typeof contents === "number" ? new Uint8Array(contents) : contents;
    const size = body.length;
    const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
    const tag = bytes("ID3", [4, 0, footer ? 0x10 : 0], syncsafe, body);
    return footer ? bytes(tag, "3DI", [4, 0, 0x10], syncsafe) : tag;
}

/**
 * The audio frames of an MPEG-1 layer III file as ffmpeg writes it, without its ID3 tags or the Info
 * frame before the audio. It is read here rather than by the SDK, so the files built from it do not
 * change with the code under test.
 */
export function mp3AudioFrames(file: Uint8Array): Uint8Array<ArrayBuffer> {
    let start = 0;
    if (hasText(file, 0, "ID3")) {
        const footer = file[5] & 0x10 ? 10 : 0;
        start = 10 + ((file[6] << 21) | (file[7] << 14) | (file[8] << 7) | file[9]) + footer;
    }
    // The Info tag follows the side information, which is 17 bytes for mono and 32 otherwise.
    const sideInfoBytes = file[start + 3] >> 6 === 3 ? 17 : 32;
    if (hasText(file, start + 4 + sideInfoBytes, "Info") || hasText(file, start + 4 + sideInfoBytes, "Xing")) {
        const b2 = file[start + 2];
        const bitrate = MPEG1_BITRATES[b2 >> 4];
        start += Math.floor((144000 * bitrate) / MPEG1_SAMPLE_RATES[(b2 >> 2) & 3]) + ((b2 >> 1) & 1);
    }
    const end = hasText(file, file.length - 128, "TAG") ? file.length - 128 : file.length;
    return file.slice(start, end);
}

function hasText(data: Uint8Array, offset: number, text: string): boolean {
    return String.fromCharCode(...data.subarray(offset, offset + text.length)) === text;
}

/** A WAV file built field by field, so a test can give it a header the SDK cannot read. */
export function rawWav({
    tag = 0x0001,
    sampleRate = 16000,
    channels = 1,
    bits = 16,
    data,
    extensible = false,
    dataSize,
    afterData = new Uint8Array(0),
    blockAlign = channels * ((bits + 7) >> 3),
    riffSize,
    riffId = "RIFF",
}: {
    tag?: number;
    sampleRate?: number;
    channels?: number;
    bits?: number;
    data: Uint8Array;
    extensible?: boolean;
    dataSize?: number;
    afterData?: Uint8Array;
    blockAlign?: number;
    riffSize?: number;
    riffId?: string;
}): Uint8Array<ArrayBuffer> {
    let fmt = bytes(
        uint16(extensible ? 0xfffe : tag),
        uint16(channels),
        uint32(sampleRate),
        uint32(0),
        uint16(blockAlign),
        uint16(bits),
    );
    if (extensible) {
        const subformat = bytes(uint16(tag), SUBFORMAT_GUID_SUFFIX);
        fmt = bytes(fmt, uint16(22), uint16(bits), uint32(0), subformat);
    }
    // An odd-sized chunk before the data exercises the padding byte that follows it.
    const info = bytes("INFOISFT", uint32(5), "Lavf", [0]);
    const body = bytes(
        "WAVE",
        "fmt ",
        uint32(fmt.length),
        fmt,
        "LIST",
        uint32(info.length),
        info,
        [0],
        "data",
        uint32(dataSize ?? data.length),
        data,
        afterData,
    );
    return bytes(riffId, uint32(riffSize ?? body.length), body);
}

/**
 * A WAV file holding `samples`, interleaved with `channels` samples to a frame and scaled to -1 to 1.
 */
export function samplesWav(
    samples: ArrayLike<number>,
    {
        channels,
        sampleRate,
        sampleWidth = 2,
        isFloat = false,
        channelMask,
    }: { channels: number; sampleRate: number; sampleWidth?: number; isFloat?: boolean; channelMask?: number },
): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(samples.length * sampleWidth);
    const view = new DataView(data.buffer);
    const fullScale = 2 ** (sampleWidth * 8 - 1);
    for (let index = 0; index < samples.length; index++) {
        const offset = index * sampleWidth;
        if (isFloat) {
            if (sampleWidth === 4) {
                view.setFloat32(offset, samples[index], true);
            } else {
                view.setFloat64(offset, samples[index], true);
            }
            continue;
        }
        const value = Math.min(Math.max(Math.round(samples[index] * fullScale), -fullScale), fullScale - 1);
        // 8-bit samples are unsigned, centered on 128, and wider ones are two's complement.
        const stored = sampleWidth === 1 ? value + 128 : value;
        for (let byte = 0; byte < sampleWidth; byte++) {
            data[offset + byte] = Math.floor(stored / 2 ** (8 * byte)) & 0xff;
        }
    }
    return wavFile({ data, sampleRate, channels, sampleWidth, isFloat, channelMask });
}

export interface WavContents {
    formatTag: number;
    channels: number;
    // 0 when the header is not extensible.
    channelMask: number;
    sampleWidth: number;
    sampleRate: number;
    isFloat: boolean;
    byteRate: number;
    blockAlign: number;
    audio: Uint8Array;
}

/** Reads a WAV file the SDK wrote, checking that its RIFF size covers the whole file. */
export function readWav(file: Uint8Array): WavContents {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(file.length - 8);
    let offset = 12;
    let format: Omit<WavContents, "audio"> | undefined;
    for (;;) {
        const id = String.fromCharCode(...file.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        if (id === "fmt ") {
            const formatTag = view.getUint16(offset + 8, true);
            const extensible = formatTag === EXTENSIBLE;
            const tag = extensible ? view.getUint16(offset + 32, true) : formatTag;
            format = {
                formatTag,
                channels: view.getUint16(offset + 10, true),
                channelMask: extensible ? view.getUint32(offset + 28, true) : 0,
                sampleRate: view.getUint32(offset + 12, true),
                byteRate: view.getUint32(offset + 16, true),
                blockAlign: view.getUint16(offset + 20, true),
                sampleWidth: view.getUint16(offset + 22, true) / 8,
                isFloat: tag === IEEE_FLOAT,
            };
        }
        if (id === "data") {
            if (format === undefined) {
                throw new Error("The data chunk comes before the fmt chunk.");
            }
            return { ...format, audio: file.slice(offset + 8, offset + 8 + size) };
        }
        offset += 8 + size + (size % 2);
    }
}

/** The samples of a WAV file the SDK wrote, interleaved and scaled to -1 to 1. */
export function samplesOf({ sampleWidth, isFloat, audio }: WavContents): Float64Array {
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    const samples = new Float64Array(audio.length / sampleWidth);
    const fullScale = 2 ** (sampleWidth * 8 - 1);
    for (let index = 0; index < samples.length; index++) {
        const offset = index * sampleWidth;
        if (isFloat) {
            samples[index] = sampleWidth === 4 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
            continue;
        }
        let value = 0;
        for (let byte = sampleWidth - 1; byte >= 0; byte--) {
            value = value * 256 + audio[offset + byte];
        }
        if (sampleWidth === 1) {
            value -= 128;
        } else if (value >= fullScale) {
            value -= 2 * fullScale;
        }
        samples[index] = value / fullScale;
    }
    return samples;
}
