// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { type DownmixStrategy, iterAudioChunks, UnsupportedAudioError } from "../../src/audio-helpers/index";
import {
    bytes,
    collect,
    expectError,
    iterationError,
    pcm,
    rawWav,
    readWav,
    thrownBy,
    times,
    uint16,
    uint32,
    wavFile,
} from "./audioFiles";

function mono16k(data: Uint8Array): Uint8Array {
    return wavFile({ sampleRate: 16000, channels: 1, sampleWidth: 2, data });
}

function audioOf(chunks: { data: Uint8Array }[]): Uint8Array {
    return bytes(...chunks.map((chunk) => readWav(chunk.data).audio));
}

describe("iterAudioChunks with WAV files", () => {
    it("splits a WAV file into the fewest equal chunks no longer than requested", async () => {
        const audio = pcm(2500 * 16 * 2);

        const chunks = await collect(iterAudioChunks(mono16k(audio), { maxChunkMs: 1000 }));

        // 40,000 samples in 3 chunks, rather than 2 full chunks and one of 500 ms.
        expect(chunks.map((c) => [c.index, c.startMs, c.endMs])).toEqual([
            [0, 0, 833],
            [1, 833, 1667],
            [2, 1667, 2500],
        ]);
        const read = chunks.map((c) => readWav(c.data));
        expect(read.map((r) => [r.channels, r.sampleWidth, r.sampleRate])).toEqual([
            [1, 2, 16000],
            [1, 2, 16000],
            [1, 2, 16000],
        ]);
        expect(read.map((r) => r.audio.length)).toEqual([26666, 26666, 26668]);
        expect(audioOf(chunks)).toEqual(audio);
    });

    it("gives no empty final chunk for a recording that divides evenly", async () => {
        const chunks = await collect(iterAudioChunks(mono16k(pcm(2000 * 16 * 2)), { maxChunkMs: 1000 }));

        expect(times(chunks)).toEqual([
            [0, 1000],
            [1000, 2000],
        ]);
    });

    it("cuts between samples, rounding down without drifting", async () => {
        // At 22,050 Hz a 10 ms chunk is 220.5 samples long.
        const audio = pcm(22050 * 2 * 2);
        const recording = wavFile({ sampleRate: 22050, channels: 2, sampleWidth: 2, data: audio });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 10, downmixStrategy: "none" }));

        expect(chunks).toHaveLength(100);
        expect(chunks.slice(0, 4).map((c) => readWav(c.data).audio.length / 4)).toEqual([220, 221, 220, 221]);
        expect(times(chunks)).toEqual(Array.from({ length: 100 }, (_, i) => [i * 10, i * 10 + 10]));
        expect(audioOf(chunks)).toEqual(audio);
    });

    it("keeps the final samples when the duration rounds down", async () => {
        // 44,122 samples at 44,100 Hz last 1000.499 ms, which rounds down to 1000 ms.
        const audio = pcm(44122 * 2);
        const recording = wavFile({ sampleRate: 44100, channels: 1, sampleWidth: 2, data: audio });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "none" }));

        expect(audioOf(chunks)).toEqual(audio);
    });

    it("keeps the final samples when endMs is the duration the final chunk reports", async () => {
        const audio = pcm(44122 * 2);
        const recording = wavFile({ sampleRate: 44100, channels: 1, sampleWidth: 2, data: audio });
        const durationMs = (
            await collect(iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "none" }))
        ).pop()?.endMs;

        const chunks = await collect(
            iterAudioChunks(recording, { maxChunkMs: 1000, endMs: durationMs, downmixStrategy: "none" }),
        );

        expect(audioOf(chunks)).toEqual(audio);
    });

    it("gives one chunk for a recording shorter than half a millisecond", async () => {
        const audio = pcm(2);
        const recording = wavFile({ sampleRate: 3000, channels: 1, sampleWidth: 2, data: audio });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expect(times(chunks)).toEqual([[0, 0]]);
        expect(readWav(chunks[0].data).audio).toEqual(audio);
    });

    it("writes only the fmt and data chunks into each chunk", async () => {
        const audio = pcm(16 * 2 * 30);
        const recording = rawWav({ data: audio, afterData: bytes("LIST", uint32(4), "INFO") });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 20 }));

        expect(chunks).toHaveLength(2);
        for (const chunk of chunks) {
            expect(Buffer.from(chunk.data).includes("LIST")).toBe(false);
        }
        expect(audioOf(chunks)).toEqual(audio);
    });

    it("pads odd-sized audio to keep the file valid", async () => {
        // 8-bit mono samples are one byte each, so 3 ms at 1 kHz is an odd number of bytes.
        const audio = pcm(5);
        const recording = wavFile({ sampleRate: 1000, channels: 1, sampleWidth: 1, data: audio });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 3 }));

        expect(chunks.map((c) => c.data.length % 2)).toEqual([0, 0]);
        expect(chunks.map((c) => readWav(c.data).audio)).toEqual([audio.slice(0, 2), audio.slice(2)]);
    });

    it.each([
        [0x0001, 24, true],
        [0x0003, 32, false],
        [0x0003, 64, true],
    ])("keeps the format of a chunk with format tag %i, %i bits, extensible %s", async (tag, bits, extensible) => {
        const audio = pcm(16 * 2 * (bits / 8) * 10);
        const recording = rawWav({ tag, channels: 2, bits, data: audio, extensible });

        const [chunk] = await collect(iterAudioChunks(recording, { maxChunkMs: 10, downmixStrategy: "none" }));
        const [rechunked] = await collect(iterAudioChunks(chunk.data, { maxChunkMs: 10, downmixStrategy: "none" }));

        expect(rechunked.data).toEqual(chunk.data);
        expect(readWav(chunk.data).formatTag).toBe(extensible ? 0xfffe : tag);
        expect(chunk.data.slice(chunk.data.length - audio.length)).toEqual(audio);
    });

    it("corrects a block size left at 1 in the chunks", async () => {
        const audio = pcm(16 * 2 * 10);
        const recording = rawWav({ data: audio, blockAlign: 1 });

        const [chunk] = await collect(iterAudioChunks(recording, { maxChunkMs: 10 }));

        const { byteRate, blockAlign, audio: written } = readWav(chunk.data);
        expect([byteRate, blockAlign]).toEqual([32000, 2]);
        expect(written).toEqual(audio);
    });

    it("reads data of unknown size to the end of the recording", async () => {
        const audio = pcm(16 * 2 * 10);
        const recording = rawWav({ data: audio, dataSize: 0xffffffff, riffSize: 0xffffffff });

        const [chunk] = await collect(iterAudioChunks(recording, { maxChunkMs: 10 }));

        expect(readWav(chunk.data).audio).toEqual(audio);
    });

    it("reads a recording that was never closed to the end", async () => {
        const audio = pcm(16 * 2 * 10);
        // The writer filled in the sizes when it wrote the header, before any audio.
        const header = rawWav({ data: new Uint8Array(0) });
        const recording = rawWav({ data: audio, dataSize: 0, riffSize: header.length - 8 });

        const [chunk] = await collect(iterAudioChunks(recording, { maxChunkMs: 10 }));

        expect(readWav(chunk.data).audio).toEqual(audio);
    });

    it("reads a recording cut off partway through a sample to the last whole sample", async () => {
        const audio = pcm(16 * 2 * 10);
        const recording = rawWav({ data: bytes(audio, [1]), dataSize: audio.length + 100 });

        const [chunk] = await collect(iterAudioChunks(recording, { maxChunkMs: 10 }));

        expect(readWav(chunk.data).audio).toEqual(audio);
    });

    it.each([
        [rawWav({ data: pcm(32), riffId: "RF64" }), "RF64"],
        [rawWav({ tag: 0x0002, bits: 4, data: pcm(32) }), "compressed"],
        [rawWav({ tag: 0x0003, bits: 24, data: pcm(32) }), "24-bit floating point"],
        [rawWav({ sampleRate: 999, data: pcm(32) }), "below the minimum"],
        [rawWav({ sampleRate: 768_001, data: pcm(32) }), "above the maximum"],
        [rawWav({ data: pcm(32), blockAlign: 4 }), "inconsistent"],
        // The block size would not fit the header's 16 bits.
        [rawWav({ channels: 40000, data: pcm(32), blockAlign: 0 }), "inconsistent"],
        [bytes("RIFF", uint32(4), "WAVE"), "no data chunk"],
        [
            bytes(
                "RIFF",
                uint32(68),
                "WAVE",
                "data",
                uint32(32),
                pcm(32),
                "fmt ",
                uint32(16),
                uint16(1),
                uint16(1),
                uint32(16000),
                uint32(32000),
                uint16(2),
                uint16(16),
            ),
            "the data chunk comes before the fmt chunk",
        ],
    ])("rejects an unsupported WAV file with a conversion command (%#: %s)", async (recording, message) => {
        const error = await iterationError(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expectError(error, UnsupportedAudioError, message);
        expect(error.message).toContain("ffmpeg -i input.wav");
    });

    it.each([
        ["a stereo μ-law WAV file", rawWav({ tag: 0x0007, sampleRate: 8000, channels: 2, bits: 8, data: pcm(32) })],
        ["a FLAC file", bytes("fLaC", pcm(100))],
    ])("rejects %s with first_channel as it does by default", async (_, recording) => {
        const byDefault = await iterationError(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        const error = await iterationError(
            iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "first_channel" }),
        );

        expectError(error, UnsupportedAudioError, byDefault.message);
    });

    it("rejects audio that is neither MP3 nor WAV", async () => {
        const error = await iterationError(iterAudioChunks(bytes("OggS", pcm(100)), { maxChunkMs: 1000 }));

        expectError(error, UnsupportedAudioError, "Only MP3 and WAV files");
    });

    it("rejects an empty recording", async () => {
        const error = await iterationError(iterAudioChunks(mono16k(new Uint8Array(0)), { maxChunkMs: 1000 }));

        expectError(error, UnsupportedAudioError, "empty");
    });

    it("rejects a closed recording that declares no audio as empty rather than reading the chunks after it", async () => {
        const recording = rawWav({ data: new Uint8Array(0), afterData: bytes("LIST", uint32(4), "INFO") });

        const error = await iterationError(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        expectError(error, UnsupportedAudioError, "empty");
    });

    it("accepts a maxChunkMs of 1", async () => {
        const chunks = await collect(iterAudioChunks(mono16k(pcm(3 * 16 * 2)), { maxChunkMs: 1 }));

        expect(times(chunks)).toEqual([
            [0, 1],
            [1, 2],
            [2, 3],
        ]);
    });

    it.each([0, 300_001])("rejects a maxChunkMs of %i as out of range", (maxChunkMs) => {
        expectError(
            thrownBy(() => iterAudioChunks(mono16k(pcm(32)), { maxChunkMs })),
            RangeError,
            `maxChunkMs must be between 1 and 300000, got ${maxChunkMs}.`,
        );
    });

    it("rejects a fixed chunk too large for the API with the longest chunk that fits", async () => {
        // 32-bit float stereo at 48 kHz is 384,000 bytes a second, so 70 seconds is 26,880,000 bytes.
        const recording = rawWav({
            tag: 0x0003,
            sampleRate: 48000,
            channels: 2,
            bits: 32,
            data: new Uint8Array(70 * 384_000),
        });

        const error = await iterationError(
            iterAudioChunks(recording, { maxChunkMs: 300_000, split: "fixed", downmixStrategy: "none" }),
        );
        const { value: chunk } = await iterAudioChunks(recording, {
            maxChunkMs: 62499,
            split: "fixed",
            downmixStrategy: "none",
        }).next();

        expectError(error, RangeError, "maxChunkMs must be at most 62499 for this WAV file");
        expect(error.message).toContain("API limit of 25,000,000 bytes");
        expect(chunk?.data.length).toBeLessThanOrEqual(24_000_000);
    });

    it.each([
        [44100, 136054],
        [48000, 124999],
    ])("limits fixed chunks of 16-bit stereo at %i Hz to the %i ms the docs give", async (sampleRate, longest) => {
        // The maxChunkMs doc and the README quote these limits, so a change to the size limit must update them.
        const recording = rawWav({
            tag: 0x0001,
            sampleRate,
            channels: 2,
            bits: 16,
            data: new Uint8Array(140 * sampleRate * 4),
        });

        const error = await iterationError(
            iterAudioChunks(recording, { maxChunkMs: 300_000, split: "fixed", downmixStrategy: "none" }),
        );

        expectError(error, RangeError, `maxChunkMs must be at most ${longest} for this WAV file`);
    });

    it("cuts even chunks too large for the API into the fewest that fit", async () => {
        // 32-bit float stereo at 48 kHz is 384,000 bytes a second, so 130 seconds is 49,920,000 bytes,
        // which takes 3 chunks of at most 24,000,000 bytes.
        const recording = rawWav({
            tag: 0x0003,
            sampleRate: 48000,
            channels: 2,
            bits: 32,
            data: new Uint8Array(130 * 384_000),
        });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 300_000, downmixStrategy: "none" }));

        expect(times(chunks)).toEqual([
            [0, 43333],
            [43333, 86667],
            [86667, 130_000],
        ]);
        for (const chunk of chunks) {
            expect(chunk.data.length).toBeLessThanOrEqual(24_000_000);
        }
    });

    it("allows a chunk duration longer than the API accepts when the range is shorter", async () => {
        const recording = rawWav({
            tag: 0x0003,
            sampleRate: 48000,
            channels: 2,
            bits: 32,
            data: new Uint8Array(70 * 384_000),
        });

        const chunks = await collect(
            iterAudioChunks(recording, {
                maxChunkMs: 300_000,
                startMs: 10_000,
                split: "fixed",
                downmixStrategy: "none",
            }),
        );

        expect(times(chunks)).toEqual([[10_000, 70_000]]);
    });

    it.each([1.5, 2 ** 53, "1000"])("rejects a maxChunkMs of %s, which is not a safe integer", (value) => {
        expectError(
            thrownBy(() => iterAudioChunks(mono16k(pcm(32)), { maxChunkMs: value as number })),
            TypeError,
            `maxChunkMs must be a safe integer, got ${typeof value === "string" ? `"${value}"` : String(value)}.`,
        );
    });

    it.each([
        [
            undefined,
            undefined,
            [
                [0, 1000],
                [1000, 2000],
                [2000, 2500],
            ],
        ],
        [
            500,
            2500,
            [
                [500, 1500],
                [1500, 2500],
            ],
        ],
    ])("cuts fixed WAV chunks on a grid from the start, and the last holds what remains (%s to %s)", async (startMs, endMs, expected) => {
        const audio = pcm(2500 * 16 * 2);

        const chunks = await collect(
            iterAudioChunks(mono16k(audio), { maxChunkMs: 1000, startMs, endMs, split: "fixed" }),
        );

        expect(times(chunks)).toEqual(expected);
        expect(audioOf(chunks)).toEqual(audio.slice(expected[0][0] * 32, expected[expected.length - 1][1] * 32));
    });

    it("rejects a split other than even or fixed", () => {
        expectError(
            thrownBy(() => iterAudioChunks(mono16k(pcm(32000)), { maxChunkMs: 1000, split: "equal" as "even" })),
            RangeError,
            'split must be "even" or "fixed", got "equal".',
        );
    });

    it.each([
        ["average", '"average"'],
        [null, "null"],
    ])("rejects a downmixStrategy of %s", (downmixStrategy, shown) => {
        expectError(
            thrownBy(() =>
                iterAudioChunks(mono16k(pcm(32000)), {
                    maxChunkMs: 1000,
                    downmixStrategy: downmixStrategy as DownmixStrategy,
                }),
            ),
            RangeError,
            `downmixStrategy must be "mix", "first_channel" or "none", got ${shown}.`,
        );
    });

    it("splits a range into chunks timed from the start of the recording", async () => {
        const audio = pcm(5000 * 16 * 2);

        const chunks = await collect(iterAudioChunks(mono16k(audio), { maxChunkMs: 1000, startMs: 1500, endMs: 4000 }));

        expect(chunks.map((c) => [c.index, c.startMs, c.endMs])).toEqual([
            [0, 1500, 2333],
            [1, 2333, 3167],
            [2, 3167, 4000],
        ]);
        expect(audioOf(chunks)).toEqual(audio.slice(1500 * 32, 4000 * 32));
    });

    it("cuts a range between samples, rounding down from the start of the range", async () => {
        const audio = pcm(22050 * 2);
        const recording = wavFile({ sampleRate: 22050, channels: 1, sampleWidth: 2, data: audio });

        const chunks = await collect(
            iterAudioChunks(recording, { maxChunkMs: 10, startMs: 5, endMs: 45, downmixStrategy: "none" }),
        );

        expect(times(chunks)).toEqual([
            [5, 15],
            [15, 25],
            [25, 35],
            [35, 45],
        ]);
        // 5 ms is 110.25 samples and 45 ms is 992.25 samples.
        expect(audioOf(chunks)).toEqual(audio.slice(110 * 2, 992 * 2));
    });

    it("lets a range end at the duration the final chunk reports", async () => {
        // 1004 samples at 22,050 Hz last 45.533 ms, which the final chunk reports as 46 ms.
        const audio = pcm(1004 * 2);
        const recording = wavFile({ sampleRate: 22050, channels: 1, sampleWidth: 2, data: audio });
        const durationMs =
            (await collect(iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "none" }))).pop()?.endMs ??
            0;

        const chunks = await collect(
            iterAudioChunks(recording, {
                maxChunkMs: 1000,
                startMs: durationMs - 1,
                endMs: durationMs,
                downmixStrategy: "none",
            }),
        );

        expect(times(chunks)).toEqual([[45, 46]]);
        expect(readWav(chunks[0].data).audio).toEqual(audio.slice(992 * 2));
    });

    it.each([
        [-1, undefined, "startMs must not be negative, got -1."],
        [1000, 1000, "endMs must be greater than startMs, got 1000."],
        [undefined, 0, "endMs must be greater than startMs, got 0."],
    ])("rejects a range of %s to %s from the call", (startMs, endMs, message) => {
        expectError(
            thrownBy(() => iterAudioChunks(mono16k(pcm(2000 * 16 * 2)), { maxChunkMs: 1000, startMs, endMs })),
            RangeError,
            message,
        );
    });

    it.each([
        [2000, undefined, "startMs must be less than the recording's duration of 2000 ms, got 2000."],
        [undefined, 2001, "endMs must not exceed the recording's duration of 2000 ms, got 2001."],
    ])("rejects a range of %s to %s outside the recording", async (startMs, endMs, message) => {
        const error = await iterationError(
            iterAudioChunks(mono16k(pcm(2000 * 16 * 2)), { maxChunkMs: 1000, startMs, endMs }),
        );

        expectError(error, RangeError, message);
    });

    it.each([
        ["startMs", 0.5],
        ["startMs", null],
        ["endMs", 0.5],
        ["endMs", null],
    ])("rejects a %s of %s, which is not a safe integer", (name, value) => {
        expectError(
            thrownBy(() => iterAudioChunks(mono16k(pcm(32)), { maxChunkMs: 1000, [name]: value })),
            TypeError,
            `${name} must be a safe integer, got ${value}.`,
        );
    });
});
