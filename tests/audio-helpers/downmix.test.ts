// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { type DownmixStrategy, iterAudioChunks } from "../../src/audio-helpers/index";
import { collect, readWav, samplesOf, samplesWav, type WavContents } from "./audioFiles";

const FORMATS: [number, boolean][] = [
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [4, true],
    [8, true],
];
const FFMPEG_SCENARIOS: [number, number, DownmixStrategy, boolean][] = [
    [48000, 2, "mix", false],
    [44100, 2, "mix", false],
    [44100, 1, "mix", false],
    // Rates whose ratio to 16 kHz needs more filter phases than ffmpeg uses, so it interpolates.
    [44101, 2, "mix", false],
    [22051, 2, "mix", false],
    [8000, 2, "mix", false],
    [48000, 2, "first_channel", false],
    [8000, 2, "first_channel", false],
    [22050, 6, "mix", false],
    [48000, 1, "mix", true],
    // Mixing the two channels alone goes above full scale.
    [48000, 2, "mix", true],
];
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).error === undefined;

async function downmix(file: Uint8Array, downmixStrategy: DownmixStrategy = "mix"): Promise<Uint8Array> {
    const [chunk] = await collect(iterAudioChunks(file, { maxChunkMs: 300_000, downmixStrategy }));
    return chunk.data;
}

/** Uniform noise from -0.5 to 0.5, interleaved, the same on every run. */
function noise(frames: number, channels: number): Float64Array {
    let state = frames;
    const samples = new Float64Array(frames * channels);
    for (let index = 0; index < samples.length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        samples[index] = state / 2 ** 32 - 0.5;
    }
    return samples;
}

function format({ sampleRate, channels, sampleWidth, isFloat }: WavContents): [number, number, number, boolean] {
    return [sampleRate, channels, sampleWidth, isFloat];
}

function firstChannel(samples: Float64Array, channels: number): Float64Array {
    return samples.filter((_, index) => index % channels === 0);
}

function maxAbs(samples: ArrayLike<number>): number {
    let most = 0;
    for (let index = 0; index < samples.length; index++) {
        most = Math.max(most, Math.abs(samples[index]));
    }
    return most;
}

/** The gap between `value`, rounded to 32-bit floating point, and the next 32-bit value above it. */
function float32Spacing(value: number): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    const rounded = view.getFloat32(0);
    view.setUint32(0, view.getUint32(0) + 1);
    return view.getFloat32(0) - rounded;
}

function ffmpeg(file: Uint8Array, ...options: string[]): Float64Array {
    // ffmpeg's x86 code reads one more filter tap than its C code when it interpolates between filter
    // phases, so its output at such rates depends on the CPU. Clearing the CPU flags runs the C code.
    const result = spawnSync(
        "ffmpeg",
        ["-nostdin", "-v", "error", "-cpuflags", "0", "-i", "-", ...options, "-f", "f64le", "-"],
        { input: file, maxBuffer: 1 << 28 },
    );
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(`ffmpeg failed: ${result.error ?? result.stderr.toString()}`);
    }
    return new Float64Array(new Uint8Array(result.stdout).buffer);
}

describe("iterAudioChunks mixdown", () => {
    it("mixes a WAV file down to 16 kHz mono floating point by default, with the same chunk times", async () => {
        const recording = samplesWav(noise(48000 * 3, 2), { channels: 2, sampleRate: 48000 });

        const chunks = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        const asGiven = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "none" }));
        expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual(asGiven.map((c) => [c.startMs, c.endMs]));
        expect(new Set(chunks.map((c) => format(readWav(c.data)).join()))).toEqual(new Set(["16000,1,4,true"]));
        const size = (items: { data: Uint8Array }[]) => items.reduce((total, c) => total + c.data.length, 0);
        expect(size(chunks)).toBeLessThan(size(asGiven) / 2);
    });

    it("cuts an MP3 file as it is, whatever the downmix strategy", async () => {
        const recording = new Uint8Array(readFileSync(join(__dirname, "assets", "tone_mpeg1_32k.mp3")));

        const mixed = await collect(iterAudioChunks(recording, { maxChunkMs: 1000 }));

        const asGiven = await collect(iterAudioChunks(recording, { maxChunkMs: 1000, downmixStrategy: "none" }));
        expect(mixed.map((c) => c.data)).toEqual(asGiven.map((c) => c.data));
    });

    it.each<[DownmixStrategy, number, number, number, boolean]>([
        ["mix", 16000, 1, 2, false],
        ["mix", 16000, 1, 4, true],
        ["first_channel", 22050, 1, 2, false],
        ["mix", 16000, 2, 2, false],
    ])("leaves audio the API mixes the same way unchanged when it would not get smaller (%s, %i Hz, %i channels, %i bytes, float %s)", async (strategy, sampleRate, channels, sampleWidth, isFloat) => {
        const file = samplesWav(noise(1000, channels), { channels, sampleRate, sampleWidth, isFloat });

        const audio = readWav(await downmix(file, strategy));

        expect(format(audio)).toEqual([sampleRate, channels, sampleWidth, isFloat]);
        expect(samplesOf(audio)).toEqual(samplesOf(readWav(file)));
    });

    it("leaves audio with more than two channels unchanged when mixing", async () => {
        const file = samplesWav(noise(1000, 4), { channels: 4, sampleRate: 48000 });

        const audio = readWav(await downmix(file));

        expect(format(audio)).toEqual([48000, 4, 2, false]);
        expect(samplesOf(audio)).toEqual(samplesOf(readWav(file)));
    });

    it("resamples audio above 16 kHz to 16 kHz, covering every input sample", async () => {
        const audio = readWav(await downmix(samplesWav(noise(44107, 1), { channels: 1, sampleRate: 44100 })));

        expect(audio.sampleRate).toBe(16000);
        // 44107 samples at 44.1 kHz last 16002.5 samples at 16 kHz.
        expect(samplesOf(audio)).toHaveLength(16003);
    });

    it("keeps a constant level when resampling", async () => {
        const audio = readWav(
            await downmix(samplesWav(new Float64Array(4800).fill(0.25), { channels: 1, sampleRate: 48000 })),
        );

        expect(maxAbs(samplesOf(audio).map((sample) => sample - 0.25))).toBeLessThanOrEqual(1e-7);
    });

    it("keeps the overshoot of loud audio when resampling instead of clipping it", async () => {
        // The filter overshoots the edges of a full-scale square wave.
        const square = Float64Array.from({ length: 4800 }, (_, index) => (Math.floor(index / 240) % 2 === 0 ? 1 : -1));

        const samples = samplesOf(readWav(await downmix(samplesWav(square, { channels: 1, sampleRate: 48000 }))));

        expect(Math.max(...samples)).toBeGreaterThan(1);
        expect(Math.min(...samples)).toBeLessThan(-1);
    });

    it.each(
        FORMATS,
    )("mixes two channels of %i-byte samples (float %s) by adding them at -3 dB as 32-bit floating point", async (sampleWidth, isFloat) => {
        const stereo = Float64Array.from({ length: 600 }, (_, index) => (index % 2 === 0 ? 0.5 : -0.25));

        const audio = readWav(
            await downmix(samplesWav(stereo, { channels: 2, sampleRate: 48000, sampleWidth, isFloat })),
        );

        const samples = samplesOf(audio);
        expect([audio.sampleRate, audio.sampleWidth, audio.isFloat, audio.channels, samples.length]).toEqual([
            16000,
            4,
            true,
            1,
            100,
        ]);
        expect(maxAbs(samples.map((sample) => sample - 0.25 * Math.SQRT1_2))).toBeLessThanOrEqual(1e-7);
    });

    it.each(
        // Each sample width is copied the same way, so these cover integers, floating point, and the
        // 64-bit floating point that is written as 32-bit.
        FORMATS.filter(([sampleWidth]) => sampleWidth === 2 || sampleWidth >= 4),
    )("keeps every sample of the first channel of %i-byte samples (float %s)", async (sampleWidth, isFloat) => {
        const file = samplesWav(noise(1000, 2), { channels: 2, sampleRate: 8000, sampleWidth, isFloat });

        const audio = readWav(await downmix(file, "first_channel"));

        let expected = firstChannel(samplesOf(readWav(file)), 2);
        // 64-bit floating point is halved by writing it as 32-bit, the format the API converts it to.
        if (sampleWidth === 8) {
            expected = expected.map(Math.fround);
        }
        expect([audio.sampleRate, audio.sampleWidth, audio.isFloat]).toEqual([8000, Math.min(sampleWidth, 4), isFloat]);
        expect(samplesOf(audio)).toEqual(expected);
    });

    it("keeps one channel at 16 kHz as floating point with first_channel", async () => {
        const file = samplesWav(noise(48000, 2), { channels: 2, sampleRate: 48000 });

        const audio = readWav(await downmix(file, "first_channel"));

        expect(format(audio)).toEqual([16000, 1, 4, true]);
    });

    it("copies the first channel above 16 kHz when that is smaller than resampling it", async () => {
        const file = samplesWav(noise(1000, 2), { channels: 2, sampleRate: 22050, sampleWidth: 1 });

        const audio = readWav(await downmix(file, "first_channel"));

        expect([audio.sampleRate, audio.sampleWidth]).toEqual([22050, 1]);
        expect(samplesOf(audio)).toEqual(firstChannel(samplesOf(readWav(file)), 2));
    });

    it("lets timers run while it resamples a long recording", async () => {
        // A minute at 192 kHz takes a few hundred milliseconds to resample, several times the pause interval.
        const file = samplesWav(noise(192000 * 60, 1), { channels: 1, sampleRate: 192000 });
        let ticks = 0;
        const timer = setInterval(() => {
            ticks += 1;
        }, 1);

        try {
            await iterAudioChunks(file, { maxChunkMs: 300_000 }).next();
        } finally {
            clearInterval(timer);
        }

        expect(ticks).toBeGreaterThan(0);
    });

    // CI installs ffmpeg in a step of a generated workflow, which regeneration can drop. Failing there
    // rather than skipping keeps the comparison from silently no longer running.
    describe.skipIf(!HAS_FFMPEG && !process.env.CI)("compared with ffmpeg", () => {
        it.each<[number, boolean, number, number, DownmixStrategy, boolean]>([
            // Each scenario in 16-bit, and each other sample format in the first scenario. How the
            // samples are read is the same in every scenario, and the tests above cover it for every format.
            ...FFMPEG_SCENARIOS.map((scenario): [number, boolean, number, number, DownmixStrategy, boolean] => [
                2,
                false,
                ...scenario,
            ]),
            ...FORMATS.filter(([width, isFloat]) => width !== 2 || isFloat).map(
                (sampleFormat): [number, boolean, number, number, DownmixStrategy, boolean] => [
                    ...sampleFormat,
                    ...FFMPEG_SCENARIOS[0],
                ],
            ),
        ])("reaches the model as through the API's ffmpeg conversion (%i bytes, float %s, %i Hz, %i channels, %s, loud %s)", async (sampleWidth, isFloat, sampleRate, channels, strategy, loud) => {
            if (!HAS_FFMPEG) {
                throw new Error(
                    "ffmpeg is not installed, so the mixdown cannot be compared with the API's conversion.",
                );
            }
            const frames = sampleRate * 2 + 3;
            const signal = new Float64Array(frames * channels);
            const random = noise(frames, channels);
            for (let frame = 0; frame < frames; frame++) {
                for (let channel = 0; channel < channels; channel++) {
                    const index = frame * channels + channel;
                    signal[index] = loud
                        ? // A square wave just below full scale, which the resampling filter overshoots.
                          Math.floor(frame / 240) % 2 === 0
                            ? 0.999
                            : -0.999
                        : 0.3 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate) + 0.2 * random[index];
                }
            }
            const file = samplesWav(signal, { channels, sampleRate, sampleWidth, isFloat });

            const uploaded = await downmix(file, strategy);

            // The API converts every file with `ffmpeg -i <file> -f f32le -ac 1 -ar 16000 -`.
            const pick = strategy === "first_channel" ? ["-af", "pan=mono|c0=c0"] : [];
            const expected = ffmpeg(file, ...pick, "-ac", "1", "-ar", "16000");
            const heard = ffmpeg(uploaded, "-ac", "1", "-ar", "16000");
            // ffmpeg can leave out the last output sample.
            expect([0, 1]).toContain(heard.length - expected.length);
            // Both are rounded to 32-bit floating point, which may differ by a few of its steps at the loudest sample.
            const steps = float32Spacing(maxAbs(expected));
            expect(maxAbs(expected.map((sample, index) => heard[index] - sample))).toBeLessThanOrEqual(5 * steps);
        });
    });
});
