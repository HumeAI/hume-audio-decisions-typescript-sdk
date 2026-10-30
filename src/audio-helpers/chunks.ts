// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { Uploadable } from "../core/file/index.js";
import { checkDownmixStrategy, type DownmixStrategy, downmixWav } from "./downmix.js";
import { checkFile, readFile } from "./files.js";
import { ceilDiv, checkInteger, describe, floorDiv, roundDiv } from "./integers.js";
import { framesNeededBefore, isMp3, type Mp3Audio, mp3Chunk, parseMp3 } from "./mp3.js";
import { isWav, parseWav, type WavAudio, wavChunk } from "./wav.js";

// The Decisions API accepts audio up to 5 minutes long.
const MAX_CHUNK_MS = 300_000;

// The API accepts a request body of up to this many bytes, its JSON part and multipart headers included.
const MAX_REQUEST_BYTES = 25_000_000;

// The rest is left for the JSON part and multipart headers, so a chunk this size is accepted with any
// common request.
const MAX_CHUNK_BYTES = 24_000_000;

export type ChunkSplit = "even" | "fixed";

const SPLITS: readonly unknown[] = ["even", "fixed"];

/** One chunk of a longer recording, a complete audio file to send to the Decisions API on its own. */
export interface AudioChunk {
    /** Position of the chunk in the recording, starting at 0. */
    readonly index: number;
    /**
     * Where the chunk starts in the recording, in milliseconds, rounded to the nearest millisecond.
     * The first chunk of an MP3 file can start a few tens of milliseconds before 0.
     */
    readonly startMs: number;
    /** Where the chunk ends in the recording, in milliseconds, rounded to the nearest millisecond. */
    readonly endMs: number;
    /** The chunk as a file in the recording's format, after any mixdown `downmixStrategy` asks for. */
    readonly data: Uint8Array;
}

export declare namespace iterAudioChunks {
    export interface Options {
        /**
         * The longest a chunk can be, in milliseconds, from 1 to 300000. A WAV chunk must also be at
         * most 24,000,000 bytes, which leaves room for the rest of its request within the API's limit
         * of 25,000,000 bytes. 5 minutes of WAV fits only at just under 80,000 bytes per second, and
         * always fits for mono or stereo under "mix". With "even", a WAV file that does not fit is cut
         * into shorter chunks that do. With "fixed", it throws, and 16-bit stereo that is not mixed
         * down needs a `maxChunkMs` of at most 136054 at 44.1 kHz and 124999 at 48 kHz.
         */
        maxChunkMs: number;
        /** Where in the recording to start, in milliseconds. Defaults to the start of the recording. */
        startMs?: number;
        /**
         * Where in the recording to stop, in milliseconds, no later than the recording's duration.
         * Defaults to the end of the recording.
         */
        endMs?: number;
        /**
         * "even" for the fewest chunks of equal length, or "fixed" for chunks of `maxChunkMs` with a
         * shorter last chunk. Defaults to "even".
         */
        split?: ChunkSplit;
        /**
         * How a WAV file is mixed down before it is cut. Audio above 16 kHz is resampled to 16 kHz
         * with the filter the API uses, and audio at 16 kHz or below keeps its rate. Resampled audio
         * is written as 32-bit floating point, the format the API converts every file to, so loud
         * audio cannot clip.
         *
         * 1. "mix", the default, mixes two channels into one the way the API does, adding them at
         *    -3 dB each, so the model hears the same audio as it would from the original file. A file
         *    that this would not make smaller, such as 16-bit mono at 16 kHz, is cut as it is, and so
         *    is audio with more than two channels, because the API weighs those channels by the
         *    speaker positions its header declares.
         * 2. "first_channel" keeps only the first channel of a file with more than one, so the model
         *    hears only that channel. The channel is copied exactly in the recording's sample format
         *    when that is no larger than resampling it, as it is at 16 kHz or below for every sample
         *    format but 64-bit floating point. Use it when that channel holds the speaker to judge.
         *    Mono audio is treated as by "mix".
         * 3. "none" cuts the audio as it is.
         */
        downmixStrategy?: DownmixStrategy;
    }
}

export interface ChunkOptions {
    readonly maxChunkMs: number;
    readonly startMs: number;
    readonly endMs: number | undefined;
    readonly split: ChunkSplit;
    readonly downmixStrategy: DownmixStrategy;
}

/** A chunk's place in the recording, with its data left to be copied when it is needed. */
export interface PlannedChunk {
    readonly index: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly build: () => Uint8Array;
}

/**
 * Splits a recording, or part of one, into chunks short enough for the Decisions API.
 *
 * `maxChunkMs` is the longest a chunk can be, and `split` decides how the recording is divided:
 *
 * 1. "even", the default, cuts the fewest chunks that fit, of equal length, so that the last chunk
 *    is not a short remainder: 10 minutes and 1 second at a `maxChunkMs` of 300000 is cut into 3
 *    chunks of about 200 seconds.
 * 2. "fixed" makes every chunk `maxChunkMs` long except the last, which holds what remains: the
 *    same recording is cut into 2 chunks of 5 minutes and 1 of 1 second. The last chunk is billed
 *    for its context and questions like any other, however short it is. Use it when chunks must be
 *    the same length across recordings.
 *
 * No chunk is empty. Cuts fall where the format allows, as described below, so `startMs` and
 * `endMs` on each chunk give where it actually starts and ends.
 *
 * The model hears audio at 16 kHz in one channel: the API resamples and mixes down every file
 * before the model hears it. A WAV file is mixed down the same way before it is cut, by default, so
 * that the chunks are smaller to upload while the model hears the same audio. `downmixStrategy`
 * describes how. MP3 files are cut as they are, because they are already compressed.
 *
 * The whole recording is read into memory, mixed down and checked before the first chunk is
 * produced, so that a file that cannot be split is rejected before any chunk is. The options are
 * checked by this call, and the file when iteration starts, so errors about the file are thrown by
 * the first `next()`. The mixdown runs on the calling thread, taking several seconds for an hour of
 * audio above 16 kHz, and lets other work run every 50 ms or so. Each chunk's `data` is a copy, made
 * as the chunk is produced, so keeping every chunk holds the recording in memory twice.
 *
 * Apart from the WAV mixdown `downmixStrategy` asks for, the audio is copied as it is, never decoded
 * or re-encoded, so cuts fall where the format allows:
 *
 * 1. A WAV file is cut between samples, after the mixdown. With "fixed", a cut can fall up to one
 *    sample before `startMs` plus a whole multiple of `maxChunkMs`, so the cuts stay on that grid.
 *    Each chunk is a new WAV file in the sample format of the mixed-down audio, holding only its
 *    audio; other chunks in the file, such as metadata, are left out.
 * 2. An MP3 file is cut between frames, which last 24 to 72 ms depending on the sample rate, so
 *    chunks can differ in length by a frame, and a "fixed" chunk can be up to one frame shorter
 *    than `maxChunkMs`. `startMs` and `endMs` move to the nearest frame boundary. A frame can store
 *    part of its audio data in the frames before it, and its sound continues from the frame before,
 *    so each chunk also starts with the frames its first new frame needs to decode exactly. That is
 *    usually a few frames, and up to about 2 seconds at the lowest bitrates. Those frames count
 *    toward `maxChunkMs` and repeat the end of the previous chunk, or start before `startMs`. Each
 *    chunk holds only the recording's frames; tags, and the header frame that states the whole
 *    file's length, are left out. When that header frame has a LAME tag, as files from LAME and
 *    ffmpeg do, it states the silence the encoder added at each end, which players skip. Times are
 *    then measured from where a player starts the whole file, so the first chunk starts before 0,
 *    by about 25 ms for a typical 44.1 kHz file, and the last ends where the player stops.
 *
 * @param file The recording, an MP3 or WAV file, in any form `create` accepts. MP3 files of MPEG-1,
 * 2 and 2.5 layer III are supported, except free format. WAV files of integer PCM (8, 16, 24 or
 * 32-bit) and floating point (32 or 64-bit) are supported, with either the basic or the extensible
 * WAV header. A stream is read from where it is to its end. `{ path }` needs file system access,
 * which browsers do not have.
 * @param options How to cut the recording.
 * @returns The chunks in order. Their times are measured from the start of the recording, not from
 * `startMs`.
 *
 * @throws {TypeError} From this call, if `maxChunkMs`, `startMs` or `endMs` is not a safe integer, or
 * `file` is a string, which is not read as a path.
 * @throws {RangeError} From this call, if `split` is not "even" or "fixed", `downmixStrategy` is not
 * "mix", "first_channel" or "none", `maxChunkMs` is out of range, or `startMs` and `endMs` do not
 * select a range. From iteration, if `startMs` and `endMs` do
 * not select audio within the recording, `maxChunkMs` is too long with "fixed" for a WAV chunk to
 * fit the API's size limit, or too short for an MP3 chunk to hold a new frame and the frames it
 * needs.
 * @throws {Error} From iteration, if the recording is empty or not a file this helper supports, such
 * as a compressed WAV or RF64 file. Any damage to an MP3 file is found before the first chunk, so no
 * chunk is produced from a file that cannot be read to the end.
 *
 * @example
 * import { iterAudioChunks } from "@humeai/decisions/audio-helpers";
 *
 * for await (const chunk of iterAudioChunks({ path: "call.wav" }, { maxChunkMs: 60_000 })) {
 *     console.log(chunk.index, chunk.startMs, chunk.endMs, chunk.data.length);
 * }
 */
export function iterAudioChunks(
    file: Uploadable,
    options: iterAudioChunks.Options,
): AsyncGenerator<AudioChunk, void, undefined> {
    const checked = checkChunkOptions(options);
    checkFile(file);
    return produceChunks(file, checked);
}

async function* produceChunks(file: Uploadable, options: ChunkOptions): AsyncGenerator<AudioChunk, void, undefined> {
    const { data } = await readFile(file);
    for (const chunk of await planAudioChunks(data, options)) {
        yield { index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs, data: chunk.build() };
    }
}

export function checkChunkOptions({
    maxChunkMs,
    startMs,
    endMs,
    split = "even",
    downmixStrategy,
}: iterAudioChunks.Options): ChunkOptions {
    if (SPLITS.indexOf(split) < 0) {
        throw new RangeError(`split must be "even" or "fixed", got ${describe(split)}.`);
    }
    const downmix = checkDownmixStrategy(downmixStrategy);
    checkInteger("maxChunkMs", maxChunkMs);
    if (maxChunkMs < 1 || maxChunkMs > MAX_CHUNK_MS) {
        throw new RangeError(`maxChunkMs must be between 1 and ${MAX_CHUNK_MS}, got ${maxChunkMs}.`);
    }
    const start = startMs === undefined ? 0 : checkInteger("startMs", startMs);
    if (start < 0) {
        throw new RangeError(`startMs must not be negative, got ${start}.`);
    }
    if (endMs !== undefined) {
        checkInteger("endMs", endMs);
        if (endMs <= start) {
            throw new RangeError(`endMs must be greater than startMs, got ${endMs}.`);
        }
    }
    return { maxChunkMs, startMs: start, endMs, split, downmixStrategy: downmix };
}

/**
 * Mixes down and plans the chunks `iterAudioChunks` gives, without copying any chunk's data. Rejects
 * with a DecisionsError if `signal` aborts during the mixdown.
 */
export async function planAudioChunks(
    data: Uint8Array,
    options: ChunkOptions,
    signal?: AbortSignal,
): Promise<Iterable<PlannedChunk>> {
    const { maxChunkMs, startMs, endMs, split } = options;
    if (isWav(data)) {
        const mixed = await downmixWav(data, parseWav(data), options.downmixStrategy, signal);
        return wavChunks(mixed.data, mixed.wav, maxChunkMs, startMs, endMs, split);
    }
    if (isMp3(data)) {
        return mp3Chunks(data, parseMp3(data), maxChunkMs, startMs, endMs, split);
    }
    throw new Error("Unsupported audio format. Only MP3 and WAV files can be split into chunks.");
}

function checkRange(durationMs: number, startMs: number, endMs: number | undefined): void {
    // The longest range allowed ends at the duration that the final chunk reports.
    // A recording shorter than half a millisecond has a duration of 0 ms but still starts at 0.
    if (startMs > 0 && startMs >= durationMs) {
        throw new RangeError(`startMs must be less than the recording's duration of ${durationMs} ms, got ${startMs}.`);
    }
    if (endMs !== undefined && endMs > durationMs) {
        throw new RangeError(`endMs must not exceed the recording's duration of ${durationMs} ms, got ${endMs}.`);
    }
}

function wavChunks(
    data: Uint8Array,
    wav: WavAudio,
    maxChunkMs: number,
    startMs: number,
    endMs: number | undefined,
    split: ChunkSplit,
): Iterable<PlannedChunk> {
    if (wav.sampleCount === 0) {
        throw new Error("The audio is empty.");
    }
    const durationMs = toMs(wav.sampleCount, wav.sampleRate);
    checkRange(durationMs, startMs, endMs);
    // The duration is rounded to the millisecond, so it can fall short of the final sample.
    const last =
        endMs === undefined || endMs >= durationMs
            ? wav.sampleCount
            : Math.min(toSample(endMs, wav.sampleRate), wav.sampleCount);
    const first = toSample(startMs, wav.sampleRate);
    let cuts: Iterable<[number, number]>;
    if (split === "even") {
        cuts = evenWavCuts(wav, maxChunkMs, first, last);
    } else {
        checkWavSize(wav, maxChunkMs, last - first);
        cuts = fixedWavCuts(wav, maxChunkMs, startMs, first, last);
    }
    return plan(
        cuts,
        (sample) => toMs(sample, wav.sampleRate),
        (start, end) => wavChunk(data, wav, start, end),
    );
}

function wavSamplesThatFit(wav: WavAudio): number {
    // An MP3 chunk needs no such limit: at the highest bitrate, 5 minutes of MP3 is about 12 MB.
    // The header holds the RIFF, fmt and data chunk headers, and the data can need a padding byte.
    const headerBytes = 28 + wav.fmt.length + 1;
    return floorDiv(MAX_CHUNK_BYTES - headerBytes, wav.frameBytes);
}

function checkWavSize(wav: WavAudio, maxChunkMs: number, rangeSamples: number): void {
    const fitting = wavSamplesThatFit(wav);
    if (Math.min(ceilDiv(maxChunkMs * wav.sampleRate, 1000), rangeSamples) <= fitting) {
        return;
    }
    const fittingMs = floorDiv(fitting * 1000, wav.sampleRate);
    throw new RangeError(
        `maxChunkMs must be at most ${fittingMs} for this WAV file with split="fixed", so that the request for` +
            ` each chunk fits within the API limit of ${MAX_REQUEST_BYTES.toLocaleString("en-US")} bytes.` +
            ` split="even" cuts shorter chunks that fit instead, and mono or stereo audio mixed down with` +
            ` downmixStrategy="mix" fits 5-minute chunks.`,
    );
}

function mp3Chunks(
    data: Uint8Array,
    mp3: Mp3Audio,
    maxChunkMs: number,
    startMs: number,
    endMs: number | undefined,
    split: ChunkSplit,
): Iterable<PlannedChunk> {
    if (mp3.frameCount === 0) {
        throw new Error("The audio is empty.");
    }
    const durationMs = mp3TimeMs(mp3, mp3.frameCount);
    checkRange(durationMs, startMs, endMs);
    // Rounding down keeps every chunk within maxChunkMs, so a maxChunkMs of 300000 stays within the
    // API's limit.
    const framesPerChunk = floorDiv(maxChunkMs * mp3.sampleRate, 1000 * mp3.samplesPerFrame);
    const frameMs = framesMs(mp3, 1);
    if (framesPerChunk === 0) {
        throw new RangeError(`maxChunkMs must be at least ${frameMs} ms, the length of one frame of this MP3 file.`);
    }
    // Times given by the caller are often ones a chunk reported, which are rounded to the
    // millisecond, so they move to the nearest frame boundary rather than the one before. The start
    // and end of the recording can fall partway through a frame, so they keep that whole frame.
    const first = startMs === 0 ? 0 : frameAt(mp3, startMs);
    const last =
        endMs === undefined || endMs >= durationMs ? mp3.frameCount : Math.min(frameAt(mp3, endMs), mp3.frameCount);
    if (last <= first) {
        throw new RangeError(
            `startMs and endMs must be at least ${frameMs} ms apart, the length of one frame of this MP3 file.`,
        );
    }
    // A chunk that could hold only the frames needed before its first new frame would never advance.
    // Filling fails only when this check does, which also rejects a maxChunkMs that happens to work
    // for this range's cuts but not for every frame in it.
    let neededBefore = 0;
    for (let frame = first; frame < last; frame++) {
        neededBefore = Math.max(neededBefore, framesNeededBefore(mp3, frame));
    }
    const filled = fillMp3Chunks(mp3, framesPerChunk, first, last);
    if (filled === undefined || framesPerChunk <= neededBefore) {
        throw new RangeError(
            `maxChunkMs must be at least ${framesMs(mp3, neededBefore + 1)} ms for this MP3 file. Its frames` +
                ` need up to ${neededBefore} frames before them to decode, and a chunk must hold those along with` +
                " at least one new frame.",
        );
    }
    return plan(
        split === "even" ? evenMp3Cuts(mp3, filled, framesPerChunk, first, last) : filled,
        (frame) => mp3TimeMs(mp3, frame),
        (start, end) => mp3Chunk(data, mp3, start, end),
    );
}

function frameAt(mp3: Mp3Audio, ms: number): number {
    return roundDiv(ms * mp3.sampleRate + 1000 * mp3.leadingSamples, 1000 * mp3.samplesPerFrame);
}

function framesMs(mp3: Mp3Audio, frames: number): number {
    return ceilDiv(frames * mp3.samplesPerFrame * 1000, mp3.sampleRate);
}

function mp3TimeMs(mp3: Mp3Audio, frame: number): number {
    // Times are measured from where a player starts the recording, after the samples the encoder and
    // decoder add, so the first chunk can start before 0 ms. The player also stops before the
    // samples added at the end.
    return toMs(Math.min(frame * mp3.samplesPerFrame, mp3.endSample) - mp3.leadingSamples, mp3.sampleRate);
}

function evenMp3Cuts(
    mp3: Mp3Audio,
    filled: [number, number][],
    framesPerChunk: number,
    first: number,
    last: number,
): [number, number][] {
    // Filling every chunk gives the fewest chunks but can leave a short last chunk. The shortest
    // chunk length that needs no more chunks than that shares the frames out evenly instead.
    let cuts = filled;
    let low = 1;
    let high = framesPerChunk;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const shorter = fillMp3Chunks(mp3, middle, first, last);
        if (shorter !== undefined && shorter.length <= cuts.length) {
            cuts = shorter;
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    return cuts;
}

/** Cuts chunks of `framesPerChunk` frames, or undefined when a chunk cannot hold a new frame. */
function fillMp3Chunks(
    mp3: Mp3Audio,
    framesPerChunk: number,
    first: number,
    last: number,
): [number, number][] | undefined {
    const cuts: [number, number][] = [];
    let next = first;
    while (next < last) {
        // Without the frames before it, the first new frame decodes wrongly. They repeat the end of
        // the previous chunk.
        const start = next - framesNeededBefore(mp3, next);
        if (start + framesPerChunk <= next) {
            return undefined;
        }
        const end = Math.min(start + framesPerChunk, last);
        cuts.push([start, end]);
        next = end;
    }
    return cuts;
}

function* evenWavCuts(wav: WavAudio, maxChunkMs: number, first: number, last: number): Generator<[number, number]> {
    // When maxChunkMs is not a whole number of samples, a chunk can be up to one sample longer.
    const most = Math.min(ceilDiv(maxChunkMs * wav.sampleRate, 1000), wavSamplesThatFit(wav));
    const length = last - first;
    const count = ceilDiv(length, most);
    // Chunk i starts at first + floor(length * i / count). That product can pass
    // Number.MAX_SAFE_INTEGER, so the cuts are stepped by the quotient and carry the remainder.
    const step = floorDiv(length, count);
    const extra = length - step * count;
    let start = first;
    let remainder = 0;
    for (let index = 0; index < count; index++) {
        let end = start + step;
        remainder += extra;
        if (remainder >= count) {
            remainder -= count;
            end += 1;
        }
        yield [start, end];
        start = end;
    }
}

function* fixedWavCuts(
    wav: WavAudio,
    maxChunkMs: number,
    startMs: number,
    first: number,
    last: number,
): Generator<[number, number]> {
    let start = first;
    let index = 0;
    while (start < last) {
        // Each cut is computed from startMs rather than from the previous cut, so rounding does not
        // accumulate.
        const end = Math.min(toSample(startMs + (index + 1) * maxChunkMs, wav.sampleRate), last);
        yield [start, end];
        index += 1;
        start = end;
    }
}

function* plan(
    cuts: Iterable<[number, number]>,
    toMs: (position: number) => number,
    build: (start: number, end: number) => Uint8Array,
): Generator<PlannedChunk> {
    // Cuts are in samples for WAV and frames for MP3.
    let index = 0;
    for (const [start, end] of cuts) {
        yield { index, startMs: toMs(start), endMs: toMs(end), build: () => build(start, end) };
        index += 1;
    }
}

function toSample(ms: number, sampleRate: number): number {
    return floorDiv(ms * sampleRate, 1000);
}

function toMs(sample: number, sampleRate: number): number {
    return roundDiv(sample * 1000, sampleRate);
}
