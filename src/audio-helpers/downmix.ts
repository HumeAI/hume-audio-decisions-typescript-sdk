// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { abortRawResponse } from "../core/fetcher/RawResponse.js";
import { DecisionsError } from "../errors/DecisionsError.js";
import { dataView } from "./bytes.js";
import { checkChoice } from "./checks.js";
import { ceilDiv, floorDiv } from "./integers.js";
import { samplesWav, type WavAudio } from "./wav.js";

const STRATEGIES = ["mix", "first_channel", "none"] as const;

/** How a WAV file is mixed down before it is sent: "mix", "first_channel", or "none" to send it as it is. */
export type DownmixStrategy = (typeof STRATEGIES)[number];

// The model hears audio at this rate, in one channel.
const MODEL_SAMPLE_RATE = 16000;
// Front left and front right.
const STEREO_MASK = 0x3;

// The settings of ffmpeg's default resampler, which the API uses before the model hears the audio, so
// audio resampled here reaches the model as it would have without this step.
const FILTER_SIZE = 32;
const CUTOFF = 0.97;
const KAISER_BETA = 9;
// A ratio of rates that would need more phases than this gets this many instead, and an output
// between two phases is interpolated linearly between them.
const MAX_PHASES = 1024;

// Outputs computed together. Each needs a filter's length of input, so this bounds the memory used.
const BLOCK = 8192;

// The mixdown runs on the calling thread, so it lets other work run after about this long.
const YIELD_MS = 50;

interface Downmixed {
    readonly data: Uint8Array;
    readonly wav: WavAudio;
}

type Read = (sample: number) => number;
type Write = (output: number, value: number) => void;

export function checkDownmixStrategy(strategy: unknown = "mix"): DownmixStrategy {
    return checkChoice("downmixStrategy", strategy, STRATEGIES);
}

/**
 * The samples of `wav` mixed down by `strategy` into one channel, with a description of them, or
 * undefined when the file is best sent as it is: the API would mix it the same way and converting it
 * would not make it smaller. Resampled audio is at most MODEL_SAMPLE_RATE, in 32-bit floating point.
 * Rejects with a DecisionsError once `signal` aborts.
 */
export async function downmixWav(
    data: Uint8Array,
    wav: WavAudio,
    strategy: DownmixStrategy,
    signal?: AbortSignal,
): Promise<Downmixed | undefined> {
    // ffmpeg weighs channels by the speakers in the header's channel mask and leaves out the LFE
    // channel, and it refuses some two-channel masks, so only audio it mixes by adding the channels at
    // equal weight is mixed here. Anything else is sent as it is for the API to mix.
    if (strategy === "none" || (strategy === "mix" && !mixesEvenly(wav))) {
        return undefined;
    }
    const sampleRate = Math.min(wav.sampleRate, MODEL_SAMPLE_RATE);
    const count = ceilDiv(wav.sampleCount * sampleRate, wav.sampleRate);
    // The API converts every sample to 32-bit floating point, so writing that loses nothing and cannot
    // clip, but it is larger than some recordings that the API would convert just the same.
    const converted = samplesWav({ channels: 1, sampleRate, sampleWidth: 4, isFloat: true, sampleCount: count });
    const unchangedBytes = wav.sampleCount * wav.frameBytes;
    const copyBytes = wav.sampleCount * wav.sampleWidth;
    const convertedBytes = count * converted.frameBytes;
    // The API would mix every channel, so the first is taken out even when that is not smaller.
    const picksChannel = strategy === "first_channel" && wav.channels > 1;
    if (!picksChannel && convertedBytes >= unchangedBytes) {
        return undefined;
    }
    // A copy of the channel's samples is exact, so it is preferred whenever it is no larger.
    if (picksChannel && copyBytes <= convertedBytes) {
        const picked = new Uint8Array(copyBytes);
        await paced(copyFirstChannel(data, wav, picked), signal);
        const { sampleWidth, isFloat, sampleCount } = wav;
        return {
            data: picked,
            wav: samplesWav({ channels: 1, sampleRate: wav.sampleRate, sampleWidth, isFloat, sampleCount }),
        };
    }
    const read = monoReader(data, wav, strategy === "mix" && wav.channels === 2);
    const out = new Uint8Array(convertedBytes);
    const view = dataView(out);
    // Integer samples are scaled to the range -1 to 1, as ffmpeg does.
    const fullScale = wav.isFloat ? 1 : 2 ** (wav.sampleWidth * 8 - 1);
    const write: Write = (output, value) => view.setFloat32(output * 4, value / fullScale, true);
    await paced(
        sampleRate === wav.sampleRate
            ? copySamples(read, write, count)
            : resample(read, write, wav.sampleCount, wav.sampleRate, sampleRate, count),
        signal,
    );
    return { data: out, wav: converted };
}

function mixesEvenly({ channels, channelMask }: WavAudio): boolean {
    return channels === 1 || (channels === 2 && (channelMask === 0 || channelMask === STEREO_MASK));
}

function* copyFirstChannel(data: Uint8Array, wav: WavAudio, picked: Uint8Array): Generator<void> {
    const { dataStart, frameBytes, sampleWidth, sampleCount } = wav;
    for (let start = 0; start < sampleCount; start += BLOCK) {
        const end = Math.min(start + BLOCK, sampleCount);
        for (let sample = start; sample < end; sample++) {
            const from = dataStart + sample * frameBytes;
            const to = sample * sampleWidth;
            for (let byte = 0; byte < sampleWidth; byte++) {
                picked[to + byte] = data[from + byte];
            }
        }
        yield;
    }
}

function* copySamples(read: Read, write: Write, count: number): Generator<void> {
    for (let start = 0; start < count; start += BLOCK) {
        const end = Math.min(start + BLOCK, count);
        for (let output = start; output < end; output++) {
            write(output, read(output));
        }
        yield;
    }
}

function* resample(
    read: Read,
    write: Write,
    length: number,
    fromRate: number,
    toRate: number,
    count: number,
): Generator<void> {
    const phases = Math.min(toRate / gcd(fromRate, toRate), MAX_PHASES);
    const interpolates = (phases * fromRate) % toRate !== 0;
    const factor = (toRate * CUTOFF) / fromRate;
    // ffmpeg rounds the filter length up to an even number.
    let taps = Math.ceil(FILTER_SIZE / factor);
    taps += taps % 2;
    const center = (taps - 1) >> 1;
    const bank = filterBank(phases, factor, taps, interpolates);
    // Output k lies k * fromRate / toRate inputs in, which is `steps(k)` phases. With the ratio's exact
    // phases, every output falls on a phase, and otherwise the remainder places it between two. k is
    // split at toRate so that no product passes Number.MAX_SAFE_INTEGER.
    const phaseStep = fromRate * phases;
    const steps = (output: number) =>
        floorDiv(output, toRate) * phaseStep + floorDiv((output % toRate) * phaseStep, toRate);
    let segment = new Float64Array(0);
    for (let start = 0; start < count; start += BLOCK) {
        const end = Math.min(start + BLOCK, count);
        const low = floorDiv(steps(start), phases) - center;
        const inputs = floorDiv(steps(end - 1), phases) - center + taps - low;
        if (segment.length < inputs) {
            segment = new Float64Array(inputs);
        }
        for (let index = 0; index < inputs; index++) {
            segment[index] = read(reflect(low + index, length));
        }
        for (let output = start; output < end; output++) {
            const position = steps(output);
            const first = floorDiv(position, phases);
            const offset = first - center - low;
            const row = (position - first * phases) * taps;
            let sample = 0;
            for (let tap = 0; tap < taps; tap++) {
                sample += segment[offset + tap] * bank[row + tap];
            }
            if (interpolates) {
                let following = 0;
                for (let tap = 0; tap < taps; tap++) {
                    following += segment[offset + tap] * bank[row + taps + tap];
                }
                const remainder = ((output % toRate) * phaseStep) % toRate;
                sample += (following - sample) * (remainder / toRate);
            }
            write(output, sample);
        }
        yield;
    }
}

function reflect(position: number, length: number): number {
    // ffmpeg reflects the audio at both ends, so the first and last outputs match its own.
    let reflected = Math.abs(position);
    if (reflected >= length) {
        reflected = 2 * length - 1 - reflected;
    }
    return Math.min(Math.max(reflected, 0), length - 1);
}

/**
 * A Kaiser-windowed sinc low-pass filter for each phase, built the way swresample builds its own, one
 * row of `taps` after another, followed by the phase that ends an interpolation when `interpolates`.
 */
function filterBank(phases: number, factor: number, taps: number, interpolates: boolean): Float64Array {
    const center = (taps - 1) >> 1;
    const bank = new Float64Array((phases + (interpolates ? 1 : 0)) * taps);
    for (let phase = 0; phase < phases; phase++) {
        for (let tap = 0; tap < taps; tap++) {
            const x = Math.PI * (tap - center - phase / phases) * factor;
            const sinc = x === 0 ? 1 : Math.sin(x) / x;
            const ratio = (2 * x) / (factor * taps * Math.PI);
            bank[phase * taps + tap] = sinc * besselI0(KAISER_BETA * Math.sqrt(Math.max(1 - ratio * ratio, 0)));
        }
    }
    // Every phase is scaled by the first phase's sum, as swresample does, so a constant level is kept.
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
        sum += bank[tap];
    }
    for (let index = 0; index < phases * taps; index++) {
        bank[index] /= sum;
    }
    if (interpolates) {
        // swresample builds the phase that ends an interpolation by moving the first phase one tap later
        // in its buffer, whose length is padded to a multiple of 8. The tap that falls off the end, zero
        // unless the filter needs no padding, wraps around to the start.
        const last = phases * taps;
        bank[last] = taps % 8 === 0 ? bank[taps - 1] : 0;
        bank.set(bank.subarray(0, taps - 1), last + 1);
    }
    return bank;
}

function besselI0(x: number): number {
    // The power series converges within a few dozen terms for the window's arguments, which are at
    // most KAISER_BETA.
    const quarterSquare = (x * x) / 4;
    let sum = 1;
    let term = 1;
    for (let k = 1; term > sum * Number.EPSILON; k++) {
        term *= quarterSquare / (k * k);
        sum += term;
    }
    return sum;
}

function monoReader(data: Uint8Array, wav: WavAudio, mixes: boolean): Read {
    const read = sampleReader(data, wav);
    const { dataStart, frameBytes, sampleWidth } = wav;
    if (mixes) {
        // ffmpeg adds the two channels at -3 dB each when it writes floating point, as the API does.
        return (sample) => {
            const offset = dataStart + sample * frameBytes;
            return (read(offset) + read(offset + sampleWidth)) * Math.SQRT1_2;
        };
    }
    return (sample) => read(dataStart + sample * frameBytes);
}

function sampleReader(data: Uint8Array, wav: WavAudio): (offset: number) => number {
    const view = dataView(data);
    if (wav.isFloat) {
        return wav.sampleWidth === 4
            ? (offset) => view.getFloat32(offset, true)
            : (offset) => view.getFloat64(offset, true);
    }
    switch (wav.sampleWidth) {
        case 1:
            // 8-bit WAV samples are unsigned, centered on 128.
            return (offset) => data[offset] - 128;
        case 2:
            return (offset) => view.getInt16(offset, true);
        case 3:
            // Shifting the top byte into the sign bit and back sign-extends the sample.
            return (offset) => ((data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)) << 8) >> 8;
        default:
            return (offset) => view.getInt32(offset, true);
    }
}

/** Runs `work` a block at a time, letting other work run about every YIELD_MS. */
async function paced(work: Iterator<void>, signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal);
    let resumed = Date.now();
    while (!work.next().done) {
        if (Date.now() - resumed >= YIELD_MS) {
            await nextTask();
            throwIfAborted(signal);
            resumed = Date.now();
        }
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        // The error the client throws when it aborts a request, so that an abort is caught the same
        // way wherever it lands.
        throw new DecisionsError({
            message: "The user aborted a request",
            rawResponse: abortRawResponse,
            cause: signal.reason,
        });
    }
}

function nextTask(): Promise<void> {
    // A promise alone would not let timers or I/O run, and browsers delay a nested setTimeout by at
    // least 4 ms, which adds up over a long mixdown.
    if (typeof setImmediate === "function") {
        return new Promise((resolve) => setImmediate(() => resolve()));
    }
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            // A port with a message handler keeps Node's event loop alive until it is closed.
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(undefined);
    });
}

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}
