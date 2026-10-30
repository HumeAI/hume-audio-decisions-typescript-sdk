// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { readFileSync } from "fs";
import { join } from "path";
import { type AudioChunk, type ChunkSplit, iterAudioChunks } from "../../src/audio-helpers/index";
import { bytes, collect, expectError, iterationError } from "./audioFiles";

const MPEG1 = 3;
const MPEG2 = 2;
const MPEG25 = 0;

const ASSETS = join(__dirname, "assets");

interface FrameOptions {
    version?: number;
    bitrateIndex?: number;
    sampleRateIndex?: number;
    padding?: number;
    layer?: number;
    mono?: boolean;
    length?: number;
    reservoir?: number;
    checksum?: boolean;
}

/**
 * Builds an MP3 frame of `length` bytes whose body identifies it by `number`, storing `reservoir`
 * bytes of its audio data in the frames before it.
 */
function frame(
    number: number,
    {
        version = MPEG1,
        bitrateIndex = 9,
        sampleRateIndex = 0,
        padding = 0,
        layer = 1,
        mono = false,
        length = 417,
        reservoir = 0,
        checksum = false,
    }: FrameOptions = {},
): Uint8Array {
    const data = new Uint8Array(length);
    data.set([
        0xff,
        0xe0 | (version << 3) | (layer << 1) | (checksum ? 0 : 1),
        (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1),
        (mono ? 3 : 0) << 6,
    ]);
    const identity = [number >>> 24, (number >> 16) & 0xff, (number >> 8) & 0xff, number & 0xff];
    for (let index = 4; index < length; index++) {
        data[index] = identity[(index - 4) % 4];
    }
    const sideInfo = checksum ? 6 : 4;
    if (version === MPEG1) {
        data.set([reservoir >> 1, (reservoir & 1) << 7], sideInfo);
    } else {
        data[sideInfo] = reservoir;
    }
    return data;
}

function frames(count: number, options: FrameOptions = {}): Uint8Array[] {
    return Array.from({ length: count }, (_, number) => frame(number, options));
}

function id3v2(size: number, { footer = false }: { footer?: boolean } = {}): Uint8Array {
    const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
    const tag = bytes("ID3", [4, 0, footer ? 0x10 : 0], syncsafe, new Uint8Array(size));
    return footer ? bytes(tag, "3DI", [4, 0, 0x10], syncsafe) : tag;
}

function vbrFrame(marker: string, offset: number, { mono = false }: { mono?: boolean } = {}): Uint8Array {
    const data = frame(0, { mono });
    data.set(bytes(marker), offset);
    return data;
}

/** Builds an Info frame stating the frame count and, in a LAME tag, the samples the encoder added. */
function lameFrame({
    delay,
    padding,
    frames,
    version = MPEG1,
}: {
    delay: number;
    padding: number;
    frames: number;
    version?: number;
}): Uint8Array {
    // The Info header follows the side information, which is 32 bytes in a stereo MPEG-1 frame and 17
    // in a stereo MPEG-2 frame of 64 kbit/s at 22,050 Hz.
    const info = version === MPEG1 ? 36 : 21;
    const data = version === MPEG1 ? frame(0) : frame(0, { version, bitrateIndex: 8, length: 208 });
    data.set(bytes("Info"), info);
    // Only the frame count is present, so the LAME tag follows it.
    const view = new DataView(data.buffer);
    view.setUint32(info + 4, 1);
    view.setUint32(info + 8, frames);
    data.set(bytes("LAME"), info + 12);
    data.set([delay >> 4, ((delay & 0x0f) << 4) | (padding >> 8), padding & 0xff], info + 33);
    return data;
}

function concatFrames(parts: Uint8Array[]): Uint8Array {
    return bytes(...parts);
}

function times(chunks: AudioChunk[]): [number, number][] {
    return chunks.map((chunk) => [chunk.startMs, chunk.endMs]);
}

function withIndexes(chunks: AudioChunk[], shift: number): AudioChunk[] {
    return chunks.map((chunk) => ({ ...chunk, index: chunk.index + shift }));
}

function reservoirFrames(): Uint8Array[] {
    return Array.from({ length: 100 }, (_, n) =>
        frame(n, { bitrateIndex: 1, length: 104, reservoir: n >= 8 ? 511 : 0 }),
    );
}

describe("iterAudioChunks with MP3 files", () => {
    it("splits an MP3 file between frames into the fewest even chunks no longer than requested", async () => {
        // MPEG-1 frames at 44.1 kHz hold 1152 samples, about 26.12 ms, so 38 fit in a second. Each chunk
        // after the first repeats the frame before its first new frame, whose output is blended into it.
        // Chunks of 38 frames would need 3 chunks, the last of 26 frames, and 34 is the fewest that still
        // need only 3.
        const all = frames(100);

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 1000 }));

        expect(chunks.map((c) => [c.index, c.startMs, c.endMs])).toEqual([
            [0, 0, 888],
            [1, 862, 1750],
            [2, 1724, 2612],
        ]);
        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 34)),
            concatFrames(all.slice(33, 67)),
            concatFrames(all.slice(66)),
        ]);
    });

    it("fills fixed MP3 chunks with as many frames as fit, and the last holds what remains", async () => {
        const all = frames(100);

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 1000, split: "fixed" }));

        expect(chunks.map((c) => [c.index, c.startMs, c.endMs])).toEqual([
            [0, 0, 993],
            [1, 967, 1959],
            [2, 1933, 2612],
        ]);
        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 38)),
            concatFrames(all.slice(37, 75)),
            concatFrames(all.slice(74)),
        ]);
    });

    it("keeps MP3 chunks of the maximum duration within five minutes", async () => {
        // 32 kbit/s frames at 44.1 kHz are 104 bytes long. 11,484 frames fit in 5 minutes, and the
        // second chunk repeats one frame, so 22,967 frames fill exactly 2 chunks.
        const all = frames(22967, { bitrateIndex: 1, length: 104 });

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 300_000 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all.slice(0, 11484)), concatFrames(all.slice(11483))]);
        expect(chunks[0].endMs).toBe(299_990);
    });

    it.each([
        // MPEG-2 frames at 22,050 Hz hold 576 samples, about 26.12 ms.
        [
            MPEG2,
            0,
            208,
            262,
            [
                [0, 209],
                [183, 392],
                [366, 522],
            ],
        ],
        // MPEG-2.5 frames at 8 kHz hold 576 samples, 72 ms.
        [
            MPEG25,
            2,
            576,
            720,
            [
                [0, 576],
                [504, 1080],
                [1008, 1440],
            ],
        ],
    ])("times MPEG-2 and 2.5 frames at 576 samples (version %i)", async (version, sampleRateIndex, length, maxChunkMs, expected) => {
        // Bitrate index 8 is 64 kbit/s for MPEG-2 and 2.5.
        const all = frames(20, { version, bitrateIndex: 8, sampleRateIndex, length });

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs }));

        expect(times(chunks)).toEqual(expected);
        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 8)),
            concatFrames(all.slice(7, 15)),
            concatFrames(all.slice(14)),
        ]);
    });

    it("reads padded frames as one byte longer", async () => {
        const all = Array.from({ length: 10 }, (_, n) => frame(n, { padding: n % 2, length: 417 + (n % 2) }));

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 60 }));

        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 2)),
            ...Array.from({ length: 8 }, (_, i) => concatFrames(all.slice(i + 1, i + 3))),
        ]);
    });

    it("leaves tags out of the chunks", async () => {
        const all = frames(10);
        const id3v1 = bytes("TAG", new Uint8Array(125));
        const recording = bytes(
            id3v2(300, { footer: true }),
            id3v2(20),
            concatFrames(all),
            "APETAGEX",
            new Uint8Array(24),
            id3v1,
        );

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
    });

    it.each([
        ["Xing", vbrFrame("Xing", 36)],
        ["Info", vbrFrame("Info", 36)],
        ["VBRI", vbrFrame("VBRI", 36)],
        // The side information before a Xing header is shorter in a mono frame.
        ["mono Xing", vbrFrame("Xing", 21, { mono: true })],
    ])("leaves out a %s header frame stating the whole file's length", async (_, header) => {
        const all = frames(10);

        const chunks = await collect(iterAudioChunks(bytes(header, concatFrames(all)), { maxChunkMs: 1000 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
        expect(chunks[0].endMs).toBe(261);
    });

    it("measures MP3 times from where players start when a LAME tag states the samples added", async () => {
        // Players leave out 576 + 529 samples at the start and 1000 - 529 at the end, so the recording
        // starts 25.06 ms into the first frame and ends 225.48 ms after that.
        const all = frames(10);
        const recording = bytes(lameFrame({ delay: 576, padding: 1000, frames: 10 }), concatFrames(all));

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expect(times(chunks)).toEqual([[-25, 225]]);
        expect(chunks[0].data).toEqual(concatFrames(all));
    });

    it("keeps the frames holding the start and end for an MP3 range from 0 to the duration", async () => {
        const all = frames(10);
        const recording = bytes(lameFrame({ delay: 576, padding: 1000, frames: 10 }), concatFrames(all));

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, startMs: 0, endMs: 225 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
        const error = await iterationError(iterAudioChunks(recording, { maxChunkMs: 1000, endMs: 226 }));
        expectError(error, RangeError, "endMs must not exceed the recording's duration of 225 ms");
    });

    it("keeps the first frame of an MPEG-2 file whose recording starts after it", async () => {
        // Players leave out 576 + 529 samples at the start, nearly two MPEG-2 frames of 576 samples, so
        // the recording starts partway through the second frame.
        const all = frames(20, { version: MPEG2, bitrateIndex: 8, length: 208 });
        const recording = bytes(
            lameFrame({ delay: 576, padding: 1000, frames: 20, version: MPEG2 }),
            concatFrames(all),
        );

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 300_000 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
    });

    it("continues from a chunk when an MP3 range with a LAME tag starts where that chunk reported it ends", async () => {
        const recording = bytes(lameFrame({ delay: 576, padding: 1000, frames: 100 }), concatFrames(frames(100)));
        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        const rest = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, startMs: chunks[0].endMs }));

        expect(rest).toEqual(withIndexes(chunks.slice(1), -1));
    });

    it("keeps the final frame whole for an MP3 cut off before the samples added at the end", async () => {
        // The header counts 12 frames, so the samples added at the end were in the 2 that are missing.
        const recording = bytes(lameFrame({ delay: 576, padding: 1000, frames: 12 }), concatFrames(frames(10)));

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expect(times(chunks)).toEqual([[-25, 236]]);
    });

    it("reads an MP3 cut off partway through a frame to the last whole frame", async () => {
        const all = frames(10);

        const chunks = await collect(
            iterAudioChunks(bytes(concatFrames(all), all[0].slice(0, 200)), { maxChunkMs: 1000 }),
        );

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
    });

    it("leaves out bytes after the last frame that are not a frame followed by an ID3v1 tag", async () => {
        const all = frames(10);
        const recording = bytes(
            concatFrames(all),
            new Uint8Array(64),
            [0xff],
            new Uint8Array(63),
            "TAG",
            new Uint8Array(125),
        );

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all)]);
    });

    it("moves an MP3 range to the nearest frame boundary", async () => {
        const all = frames(100);

        // 990 ms is 37.9 frames in and 1990 ms is 76.2 frames in.
        const chunks = await collect(
            iterAudioChunks(concatFrames(all), { maxChunkMs: 2000, startMs: 990, endMs: 1990 }),
        );

        expect(times(chunks)).toEqual([[967, 1985]]);
        expect(chunks[0].data).toEqual(concatFrames(all.slice(37, 76)));
    });

    it("continues from a chunk when an MP3 range starts where that chunk reported it ends", async () => {
        const recording = concatFrames(frames(100));
        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        // The first chunk's end, 992.65 ms, is reported as 993 ms, which is past the frame boundary.
        const rest = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, startMs: chunks[0].endMs }));

        expect(rest).toEqual(withIndexes(chunks.slice(1), -1));
    });

    it("rejects a damaged MP3 before any chunk is produced", async () => {
        const all = frames(100);
        all[90] = new Uint8Array(all[90].length);
        const chunks = iterAudioChunks(concatFrames(all), { maxChunkMs: 1000 });

        const error = await iterationError(chunks);

        expectError(error, Error, "no MPEG audio frame at byte 37530");
    });

    it.each([
        [concatFrames(frames(10, { bitrateIndex: 0 })), "free format"],
        [concatFrames(frames(10, { layer: 2 })), "layer I and II"],
        [
            concatFrames([...frames(5), ...frames(5, { sampleRateIndex: 1, length: 384 })]),
            "sample rate changes at byte 2085",
        ],
        [bytes(frame(0).slice(0, 2), [0xf0, 0x00], new Uint8Array(413)), "invalid frame header at byte 0"],
        [id3v2(10), "no MPEG audio frame"],
    ])("rejects an unsupported MP3 with a conversion command (%#: %s)", async (recording, message) => {
        const error = await iterationError(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expectError(error, Error, message);
        expect(error.message).toContain("ffmpeg -i input.mp3");
    });

    it("rejects an MP3 holding only a header frame as empty", async () => {
        const error = await iterationError(iterAudioChunks(vbrFrame("Info", 36), { maxChunkMs: 1000 }));

        expectError(error, Error, "empty");
    });

    it("rejects a chunk duration shorter than one frame", async () => {
        const error = await iterationError(iterAudioChunks(concatFrames(frames(10)), { maxChunkMs: 26 }));

        expectError(error, RangeError, "maxChunkMs must be at least 27 ms");
    });

    it("rejects an MP3 range shorter than one frame", async () => {
        const error = await iterationError(
            iterAudioChunks(concatFrames(frames(10)), { maxChunkMs: 1000, startMs: 100, endMs: 110 }),
        );

        expectError(error, RangeError, "startMs and endMs must be at least 27 ms apart");
    });

    it("rejects an MP3 range past the end", async () => {
        const error = await iterationError(iterAudioChunks(concatFrames(frames(10)), { maxChunkMs: 1000, endMs: 262 }));

        expectError(error, RangeError, "endMs must not exceed the recording's duration of 261 ms");
    });

    it("starts an MP3 chunk with the frames its first new frame needs", async () => {
        // Each stereo MPEG-1 frame of 417 bytes holds 381 bytes of audio data after its header and side
        // information, so 300 bytes stored earlier are all in the frame before. A decoder may drop the
        // data of the first frame it reads, so another frame comes before that one. The frame before
        // the first new frame needs the same two frames before it.
        const all = Array.from({ length: 100 }, (_, n) => frame(n, { reservoir: n === 0 ? 0 : 300 }));

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 1000 }));

        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 36)),
            concatFrames(all.slice(33, 69)),
            concatFrames(all.slice(66)),
        ]);
        expect(times(chunks)).toEqual([
            [0, 940],
            [862, 1802],
            [1724, 2612],
        ]);
    });

    it.each<[string, FrameOptions, number, number, number]>([
        // 381 bytes of audio data after a 4-byte header and 32 bytes of side information. One more
        // frame comes before the frames holding the data, because a decoder may drop the data of the
        // first frame it reads.
        ["stereo", {}, 10, 381, 2],
        ["stereo", {}, 10, 382, 3],
        // Mono frames have 17 bytes of side information, leaving 396.
        ["mono", { mono: true }, 10, 396, 2],
        ["mono", { mono: true }, 10, 397, 3],
        // A checksum takes 2 more bytes, leaving 379.
        ["checksum", { checksum: true }, 10, 379, 2],
        ["checksum", { checksum: true }, 10, 380, 3],
        // MPEG-2 stores the distance in 8 bits after 17 bytes of side information. 64 kbit/s frames
        // at 22,050 Hz are 208 bytes long, leaving 187.
        ["MPEG-2", { version: MPEG2, bitrateIndex: 8, length: 208 }, 10, 187, 2],
        ["MPEG-2", { version: MPEG2, bitrateIndex: 8, length: 208 }, 10, 188, 3],
        // The frame before the first new frame is always needed, along with the frames it needs.
        ["stereo", {}, 10, 0, 1],
        ["stereo", {}, 9, 381, 3],
        ["stereo", {}, 9, 382, 4],
    ])("counts only the audio data of earlier frames as needed (%s, frame %i storing %i bytes earlier)", async (_, options, storingFrame, reservoir, needed) => {
        const all = Array.from({ length: 20 }, (_, n) =>
            frame(n, { ...options, reservoir: n === storingFrame ? reservoir : 0 }),
        );
        const recording = concatFrames(all);
        const [whole] = await collect(iterAudioChunks(recording, { maxChunkMs: 300_000 }));

        const chunks = await collect(
            iterAudioChunks(recording, { maxChunkMs: 300_000, startMs: Math.floor(whole.endMs / 2) }),
        );

        expect(chunks.map((c) => c.data)).toEqual([concatFrames(all.slice(10 - needed))]);
    });

    it("starts an MP3 range with the frames its first new frame needs", async () => {
        // 32 kbit/s stereo frames at 44.1 kHz are 104 bytes long and hold 68 bytes of audio data, so
        // data stored 511 bytes back, the most MPEG-1 allows, spans 8 frames. With the frame a decoder
        // may drop, the frame before the first new frame needs 9 frames before it.
        const all = reservoirFrames();

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 1000, startMs: 993 }));

        expect(chunks[0].data).toEqual(concatFrames(all.slice(28, 59)));
        expect(chunks[0].startMs).toBe(731);
        expect(chunks[1].data).toEqual(concatFrames(all.slice(49, 80)));
    });

    it("rejects a chunk duration too short for the frames needed", async () => {
        // 11 frames last 287.3 ms, enough for 10 needed frames and one new frame.
        const error = await iterationError(iterAudioChunks(concatFrames(reservoirFrames()), { maxChunkMs: 287 }));

        expectError(error, RangeError, "maxChunkMs must be at least 288 ms");
        expect(error.message).toContain("up to 10 frames before them");
    });

    it("rejects a chunk duration too short for the frames needed by a frame that no chunk starts at", async () => {
        // Frame 5 stores 511 bytes in the 2 frames before it, so frame 6 needs those, the frame a
        // decoder may drop, and frame 5. Chunks of 4 frames start new frames at 0, 4, 7 and so on, but
        // a range starting at frame 6 could not be cut, so no range accepts this maxChunkMs.
        const all = Array.from({ length: 20 }, (_, n) => frame(n, { reservoir: n === 5 ? 511 : 0 }));

        const error = await iterationError(iterAudioChunks(concatFrames(all), { maxChunkMs: 120 }));

        expectError(error, RangeError, "maxChunkMs must be at least 131 ms");
        expect(error.message).toContain("up to 4 frames before them");
    });

    it("advances a frame at a time with a chunk duration just long enough for the frames needed", async () => {
        const all = reservoirFrames();

        const chunks = await collect(iterAudioChunks(concatFrames(all), { maxChunkMs: 288 }));

        expect(chunks.map((c) => c.data)).toEqual([
            concatFrames(all.slice(0, 11)),
            ...Array.from({ length: 89 }, (_, i) => concatFrames(all.slice(i + 1, i + 12))),
        ]);
    });

    it.each<[string, ChunkSplit, [number, number][]]>([
        [
            "tone_mpeg1_32k.mp3",
            "even",
            [
                [-35, 829],
                [685, 1549],
                [1333, 2197],
                [1981, 2845],
                [2629, 3493],
                [3277, 4000],
            ],
        ],
        [
            "tone_mpeg1_32k.mp3",
            "fixed",
            [
                [-35, 937],
                [757, 1729],
                [1513, 2485],
                [2269, 3241],
                [3025, 3997],
                [3781, 4000],
            ],
        ],
        [
            "tone_mpeg25_8k.mp3",
            "even",
            [
                [-138, 798],
                [510, 1446],
                [1158, 2094],
                [1734, 2670],
                [2310, 3246],
                [2814, 3750],
                [3318, 4000],
            ],
        ],
        [
            "tone_mpeg25_8k.mp3",
            "fixed",
            [
                [-138, 798],
                [510, 1446],
                [1158, 2094],
                [1734, 2670],
                [2310, 3246],
                [2814, 3750],
                [3318, 4000],
            ],
        ],
    ])("cuts encoder-written %s with split %s at the times confirmed by decoding its chunks", async (name, split, expected) => {
        // The files were encoded with ffmpeg's libmp3lame from a tone mixed with noise, at a bitrate low
        // enough that almost every frame stores audio data in earlier frames. Decoding each of these
        // chunks with ffmpeg gives exactly the samples of decoding the whole file, over the chunk's new
        // frames. That was checked by hand, because CI has no decoder, so the times are pinned here.
        // With fewer frames repeated, the times change and the decoded audio does not match.
        // Times are measured from where ffmpeg and mpg123 start playing the whole file, which both play
        // for 4000 ms, so a chunk's start plus a time within the decoded chunk gives that sample.
        const recording = new Uint8Array(readFileSync(join(ASSETS, name)));

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, split }));

        expect(times(chunks)).toEqual(expected);
        const source = Buffer.from(recording);
        const firstFrame = source.indexOf(Buffer.from(chunks[0].data));
        expect(source.subarray(0, firstFrame).includes("Info")).toBe(true);
        // The file ends with a 128-byte ID3v1 tag.
        const last = chunks[chunks.length - 1].data;
        expect(source.indexOf(Buffer.from(last)) + last.length).toBe(recording.length - 128);
    });
});
