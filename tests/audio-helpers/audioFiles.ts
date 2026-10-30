// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { readFileSync } from "fs";
import { join } from "path";

const PCM = 0x0001;
const IEEE_FLOAT = 0x0003;

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

/** A WAV file with a basic header holding `data`, samples already in the given format. */
export function wavFile({
    data,
    sampleRate,
    channels,
    sampleWidth = 2,
    isFloat = false,
}: {
    data: Uint8Array;
    sampleRate: number;
    channels: number;
    sampleWidth?: number;
    isFloat?: boolean;
}): Uint8Array<ArrayBuffer> {
    const frameBytes = sampleWidth * channels;
    const fmt = bytes(
        uint16(isFloat ? IEEE_FLOAT : PCM),
        uint16(channels),
        uint32(sampleRate),
        uint32(sampleRate * frameBytes),
        uint16(frameBytes),
        uint16(sampleWidth * 8),
    );
    const body = bytes("WAVE", "fmt ", uint32(fmt.length), fmt, "data", uint32(data.length), data);
    return bytes("RIFF", uint32(body.length), body);
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
    }: { channels: number; sampleRate: number; sampleWidth?: number; isFloat?: boolean },
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
    return wavFile({ data, sampleRate, channels, sampleWidth, isFloat });
}

export interface WavContents {
    formatTag: number;
    channels: number;
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
            format = {
                formatTag,
                channels: view.getUint16(offset + 10, true),
                sampleRate: view.getUint32(offset + 12, true),
                byteRate: view.getUint32(offset + 16, true),
                blockAlign: view.getUint16(offset + 20, true),
                sampleWidth: view.getUint16(offset + 22, true) / 8,
                isFloat: formatTag === IEEE_FLOAT,
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
