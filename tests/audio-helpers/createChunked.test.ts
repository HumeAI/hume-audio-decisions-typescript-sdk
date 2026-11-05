// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import * as Decisions from "../../src/api/index";
import {
    ChunkedDecisionsResult,
    type ChunkResult,
    checkDownmix,
    type DownmixStrategy,
    iterAudioChunks,
    UnsupportedAudioError,
} from "../../src/audio-helpers/index";
import { DecisionsClient } from "../../src/Client";
import { DecisionsError } from "../../src/errors/index";
import {
    apeItem,
    apeTag,
    asset,
    bytes,
    collect,
    expectBytes,
    expectError,
    id3v2,
    iterationError,
    mp3AudioFrames,
    pcm,
    rawWav,
    rejection,
    samplesWav,
    thrownBy,
    times,
    wavFile,
} from "./audioFiles";

const REQUEST: Decisions.DecisionsRequest = {
    context: "A test call.",
    questions: { talks_over_caller: { type: "noul", instructions: "Does the agent talk over the caller?" } },
};

interface Sent {
    readonly form: FormData;
    readonly headers: Headers;
}

/** Responds to request `number`, starting at 1 and counting retries. */
type Respond = (number: number) => Response;

function wav(milliseconds: number, { sampleRate = 8000, channels = 1 } = {}): Uint8Array<ArrayBuffer> {
    return wavFile({ data: pcm(((sampleRate * milliseconds) / 1000) * 2 * channels), sampleRate, channels });
}

/** A WAV file of 8-bit μ-law samples, as phone systems record, which the SDK cannot read. */
function mulawWav(channels: number): Uint8Array<ArrayBuffer> {
    return rawWav({ tag: 0x0007, sampleRate: 8000, channels, bits: 8, data: pcm(8000 * channels) });
}

// tone_stereo_mpeg1_32k.mp3 is a 4-second 440 Hz tone in two channels, encoded with: ffmpeg -f lavfi
// -i sine=frequency=440:sample_rate=32000:duration=4 -ac 2 -c:a libmp3lame -b:a 64k
// -metadata title=test -write_id3v1 1 tone_stereo_mpeg1_32k.mp3
const STEREO_MP3 = () => asset("tone_stereo_mpeg1_32k.mp3");
const MONO_THEN_STEREO_MP3 = () =>
    bytes(mp3AudioFrames(asset("tone_mpeg1_32k.mp3")), mp3AudioFrames(asset("tone_stereo_mpeg1_32k.mp3")));
// The stereo tone's audio frames are 288 bytes each.
const STEREO_MP3_FRAME = () => mp3AudioFrames(asset("tone_stereo_mpeg1_32k.mp3")).subarray(0, 288);
const TWO_STEREO_MP3_FRAMES = () => mp3AudioFrames(asset("tone_stereo_mpeg1_32k.mp3")).subarray(0, 576);
const MONO_MP3_FRAMES = () => mp3AudioFrames(asset("tone_mpeg1_32k.mp3"));
// The mono tone's ID3v2 tag, Info frame and audio frames, without the ID3v1 tag that ends the file.
const MONO_MP3_TO_LAST_FRAME = () => asset("tone_mpeg1_32k.mp3").subarray(0, -128);
const MONO_MP3_ID3V1 = () => asset("tone_mpeg1_32k.mp3").subarray(-128);
// Mono audio up to its last whole frame, then bytes that can hold stereo audio a decoder may play.
const MONO_MP3_ENDINGS: [string, () => Uint8Array, () => Uint8Array][] = [
    ["its ID3v1 tag", MONO_MP3_TO_LAST_FRAME, MONO_MP3_ID3V1],
    ["a stereo frame cut short", MONO_MP3_FRAMES, () => STEREO_MP3_FRAME().subarray(0, 287)],
    ["one stereo frame after padding", MONO_MP3_FRAMES, () => bytes([0], STEREO_MP3_FRAME())],
    ["one stereo frame after its ID3v1 tag", MONO_MP3_TO_LAST_FRAME, () => bytes(MONO_MP3_ID3V1(), STEREO_MP3_FRAME())],
    [
        "a stereo file embedded in an ID3v2 tag",
        MONO_MP3_TO_LAST_FRAME,
        () => bytes(MONO_MP3_ID3V1(), id3v2(mp3AudioFrames(asset("tone_stereo_mpeg1_32k.mp3")))),
    ],
    [
        "stereo frames embedded in an ID3v2 tag after padding",
        MONO_MP3_FRAMES,
        () => bytes([0], id3v2(TWO_STEREO_MP3_FRAMES())),
    ],
    [
        "stereo frames in an APE tag item, with no tag header",
        MONO_MP3_FRAMES,
        () => apeTag(apeItem(TWO_STEREO_MP3_FRAMES()), { header: false }),
    ],
];
// Joined with its tags, so the mono file's ID3v1 tag comes before the stereo file's frames.
const MONO_AND_STEREO_MP3 = () => bytes(asset("tone_mpeg1_32k.mp3"), asset("tone_stereo_mpeg1_32k.mp3"));
const STEREO_MULAW = () => mulawWav(2);
const MONO_MULAW = () => mulawWav(1);
const FLAC = () => bytes("fLaC", pcm(996));

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function succeeded(number: number): Response {
    return json(200, { run_id: `run-${number}`, answers: { talks_over_caller: { type: "noul", noul: 0.5 } } });
}

function failed(status: number, code: string): Response {
    return json(status, { type: "error", code, message: code, request_id: "req" });
}

function rateLimited(): Response {
    // Hume's API gateway answers a rate limit before the service does, so the body has no error code.
    return json(429, { message: "Too many requests" });
}

function failingAt(failing: number, failure: () => Response): Respond {
    return (number) => (number === failing ? failure() : succeeded(number));
}

function decisions(sent: Sent[], respond: Respond = succeeded): DecisionsClient["decisions"] {
    return new DecisionsClient({
        apiKey: "test",
        fetch: async (_url, init) => {
            sent.push({ form: init?.body as FormData, headers: new Headers(init?.headers) });
            return respond(sent.length);
        },
    }).decisions;
}

function filePart(sent: Sent): File {
    return sent.form.get("file") as File;
}

async function fileBytes(sent: Sent): Promise<Uint8Array> {
    return new Uint8Array(await filePart(sent).arrayBuffer());
}

/** The bytes `create` uploads for `file`. */
async function uploaded(
    file: Decisions.DecisionsUpload["file"],
    downmixStrategy?: DownmixStrategy,
): Promise<Uint8Array> {
    const sent: Sent[] = [];
    await decisions(sent).create({ request: REQUEST, file, downmixStrategy });
    expect(sent).toHaveLength(1);
    return fileBytes(sent[0]);
}

function statuses(chunks: readonly ChunkResult[]): string[] {
    return chunks.map((chunk) => chunk.status);
}

function runIds(result: ChunkedDecisionsResult): (string | undefined)[] {
    return result.responses.map((response) => response?.runId);
}

/** Checks for the error the generated client throws when a request is aborted. */
function expectAbortError(error: Error): void {
    expect(error.constructor).toBe(DecisionsError);
    expect(error.message).toBe("The user aborted a request");
}

describe("createChunked", () => {
    it("sends each chunk in order and returns each response", async () => {
        const sent: Sent[] = [];
        const audio = wav(2500);

        const result = await decisions(sent).createChunked({ request: REQUEST, file: audio, maxChunkMs: 1000 });

        const expected = await collect(iterAudioChunks(audio, { maxChunkMs: 1000 }));
        expectBytes(
            await Promise.all(sent.map(fileBytes)),
            expected.map((chunk) => chunk.data),
        );
        for (const request of sent) {
            expect(JSON.parse(request.form.get("request") as string)).toEqual({
                context: "A test call.",
                questions: {
                    talks_over_caller: { type: "noul", instructions: "Does the agent talk over the caller?" },
                },
            });
        }
        expect(result.chunks.map((chunk) => [chunk.index, chunk.startMs, chunk.endMs])).toEqual([
            [0, 0, 833],
            [1, 833, 1667],
            [2, 1667, 2500],
        ]);
        expect(runIds(result)).toEqual(["run-1", "run-2", "run-3"]);
        expect(statuses(result.chunks)).toEqual(["succeeded", "succeeded", "succeeded"]);
        expect(result.chunks.map((chunk) => chunk.error)).toEqual([undefined, undefined, undefined]);
        expect(result.complete).toBe(true);
    });

    it.each<DownmixStrategy>([
        "mix",
        "first_channel",
        "none",
    ])("sends the chunks iterAudioChunks gives for downmixStrategy %s", async (downmixStrategy) => {
        const sent: Sent[] = [];
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });

        await decisions(sent).createChunked({ request: REQUEST, file: audio, maxChunkMs: 1000, downmixStrategy });

        const expected = await collect(iterAudioChunks(audio, { maxChunkMs: 1000, downmixStrategy }));
        expectBytes(
            await Promise.all(sent.map(fileBytes)),
            expected.map((chunk) => chunk.data),
        );
    });

    it("sends only the requested range", async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent).createChunked({
            request: REQUEST,
            file: wav(5000),
            maxChunkMs: 1000,
            startMs: 1500,
            endMs: 3000,
        });

        expect(sent).toHaveLength(2);
        expect(times(result.chunks)).toEqual([
            [1500, 2250],
            [2250, 3000],
        ]);
    });

    it('sends chunks of maxChunkMs when split is "fixed"', async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent).createChunked({
            request: REQUEST,
            file: wav(2500),
            maxChunkMs: 1000,
            split: "fixed",
        });

        expect(sent).toHaveLength(3);
        expect(times(result.chunks)).toEqual([
            [0, 1000],
            [1000, 2000],
            [2000, 2500],
        ]);
    });

    it("uploads each chunk with the filename and content type given", async () => {
        const sent: Sent[] = [];

        await decisions(sent).createChunked({
            request: REQUEST,
            file: { data: new Blob([wav(2000)]).stream(), filename: "call.wav", contentType: "audio/wav" },
            maxChunkMs: 1000,
        });

        expect(sent.map((request) => [filePart(request).name, filePart(request).type])).toEqual([
            ["call.wav", "audio/wav"],
            ["call.wav", "audio/wav"],
        ]);
    });

    it("applies requestOptions to every request", async () => {
        const sent: Sent[] = [];

        await decisions(sent).createChunked(
            { request: REQUEST, file: wav(2000), maxChunkMs: 1000 },
            { headers: { "X-Trace": "abc" } },
        );

        expect(sent.map((request) => request.headers.get("X-Trace"))).toEqual(["abc", "abc"]);
    });

    it("continues after a chunk whose audio cannot be decoded", async () => {
        const sent: Sent[] = [];

        const result = await decisions(
            sent,
            failingAt(2, () => failed(400, "audio_decode_failed")),
        ).createChunked({ request: REQUEST, file: wav(3000), maxChunkMs: 1000 });

        expect(sent).toHaveLength(3);
        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "succeeded"]);
        expect(result.chunks[1].error).toBeInstanceOf(Decisions.BadRequestError);
        expect(runIds(result)).toEqual(["run-1", undefined, "run-3"]);
        expect(result.complete).toBe(false);
    });

    it("narrows each result to its response or error by its status", async () => {
        const result = await decisions(
            [],
            failingAt(2, () => failed(402, "payment_required")),
        ).createChunked({
            request: REQUEST,
            file: wav(3000),
            maxChunkMs: 1000,
        });

        const outcomes = result.chunks.map((chunk) =>
            chunk.status === "succeeded"
                ? chunk.response.runId
                : chunk.status === "failed"
                  ? chunk.error.statusCode
                  : chunk.status,
        );

        expect(outcomes).toEqual(["run-1", 402, "not_attempted"]);
    });

    it("stops when no chunk has decoded before a decode failure", async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent, () => failed(400, "audio_decode_failed")).createChunked({
            request: REQUEST,
            file: wav(3000),
            maxChunkMs: 1000,
        });

        expect(sent).toHaveLength(1);
        expect(statuses(result.chunks)).toEqual(["failed", "not_attempted", "not_attempted"]);
    });

    it.each<[string, () => Response]>([
        ["out of tokens", () => failed(402, "payment_required")],
        ["unknown code", () => failed(400, "a_code_added_later")],
        ["API key rejected by the gateway", () => json(401, { message: "Invalid API key", request_id: "req" })],
    ])("stops at any other error and records the rest as not attempted: %s", async (_name, failure) => {
        const sent: Sent[] = [];

        const result = await decisions(sent, failingAt(2, failure)).createChunked({
            request: REQUEST,
            file: wav(4000),
            maxChunkMs: 1000,
        });

        expect(sent).toHaveLength(2);
        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "not_attempted", "not_attempted"]);
        expect(result.chunks[1].error).toBeInstanceOf(DecisionsError);
        expect(result.chunks.slice(2).map((chunk) => [chunk.startMs, chunk.endMs, chunk.error])).toEqual([
            [2000, 3000, undefined],
            [3000, 4000, undefined],
        ]);
        expect(result.responses[0]).toBeDefined();
        expect(result.complete).toBe(false);
    });

    it("stops when the connection drops", async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent, (number) => {
            if (number === 2) {
                throw new TypeError("fetch failed");
            }
            return succeeded(number);
        }).createChunked({ request: REQUEST, file: wav(3000), maxChunkMs: 1000 });

        expect(sent).toHaveLength(2);
        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "not_attempted"]);
        expect(result.chunks[1].error).toBeInstanceOf(DecisionsError);
        expect(result.chunks[1].error?.cause).toBeInstanceOf(TypeError);
    });

    it.each<[string, () => Response]>([
        ["an HTML error page", () => new Response("<html>413 Request Entity Too Large</html>", { status: 413 })],
        ["an empty body", () => new Response(null, { status: 400 })],
    ])("records a failure answered with %s on its chunk and keeps the responses before it", async (_, failure) => {
        const sent: Sent[] = [];

        const result = await decisions(sent, failingAt(2, failure)).createChunked({
            request: REQUEST,
            file: wav(3000),
            maxChunkMs: 1000,
        });

        expect(sent).toHaveLength(2);
        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "not_attempted"]);
        expect(runIds(result)).toEqual(["run-1", undefined, undefined]);
        expect(result.chunks[1].error).toBeInstanceOf(DecisionsError);
        expect(result.resumeMs).toBe(1000);
    });

    it("rejects with an error that did not come from a request", async () => {
        // A request the generated client cannot serialize fails before it is sent.
        const sent: Sent[] = [];
        const invalid = { questions: "none" } as unknown as Decisions.DecisionsRequest;

        const error = await rejection(
            decisions(sent).createChunked({ request: invalid, file: wav(2000), maxChunkMs: 1000 }),
        );

        expect(error).not.toBeInstanceOf(DecisionsError);
        expect(sent).toEqual([]);
    });

    it("retries a rate-limited chunk before moving on", async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent, failingAt(2, rateLimited)).createChunked({
            request: REQUEST,
            file: wav(2000),
            maxChunkMs: 1000,
        });

        expect(sent).toHaveLength(3);
        expectBytes([await fileBytes(sent[1])], [await fileBytes(sent[2])]);
        expect(runIds(result)).toEqual(["run-1", "run-3"]);
        expect(result.complete).toBe(true);
    });

    it("stops when rate limit retries run out", async () => {
        const sent: Sent[] = [];

        const result = await decisions(sent, (number) =>
            number >= 2 ? rateLimited() : succeeded(number),
        ).createChunked({ request: REQUEST, file: wav(3000), maxChunkMs: 1000 }, { maxRetries: 1 });

        expect(sent).toHaveLength(3);
        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "not_attempted"]);
        expect(result.chunks[1].error).toBeInstanceOf(Decisions.TooManyRequestsError);
    });
});

describe("iterCreateChunked", () => {
    it("yields each result before sending the next chunk", async () => {
        const sent: Sent[] = [];
        const yielded: [number, string, number][] = [];

        for await (const chunk of decisions(
            sent,
            failingAt(3, () => failed(402, "payment_required")),
        ).iterCreateChunked({ request: REQUEST, file: wav(4000), maxChunkMs: 1000 })) {
            yielded.push([chunk.index, chunk.status, sent.length]);
        }

        expect(yielded).toEqual([
            [0, "succeeded", 1],
            [1, "succeeded", 2],
            [2, "failed", 3],
            [3, "not_attempted", 3],
        ]);
    });

    it("sends nothing for a recording damaged near its end", async () => {
        const sent: Sent[] = [];
        // The chunks before the damage can be cut without reading it, so nothing is sent only if the
        // whole recording is read first.
        const audio = asset("tone_mpeg1_32k.mp3");
        audio.fill(0, 14_000, 14_200);

        const error = await iterationError(
            decisions(sent).iterCreateChunked({ request: REQUEST, file: audio, maxChunkMs: 1000 }),
        );

        expectError(error, UnsupportedAudioError, "no MPEG audio frame at byte");
        expect(sent).toEqual([]);
    });

    it("throws from the call for options that are out of range or a string file", () => {
        // Errors that do not depend on the file are thrown before iteration, as by iterAudioChunks.
        const client = decisions([]);

        expectError(
            thrownBy(() => client.iterCreateChunked({ request: REQUEST, file: wav(2000), maxChunkMs: 0 })),
            RangeError,
            "maxChunkMs must be between 1 and 300000",
        );
        expectError(
            thrownBy(() =>
                client.iterCreateChunked({
                    request: REQUEST,
                    file: "call.wav" as unknown as Decisions.DecisionsUpload["file"],
                    maxChunkMs: 1000,
                }),
            ),
            TypeError,
            'pass { path: "call.wav" }',
        );
    });

    it("throws the abort error after the results already yielded and sends no further chunk", async () => {
        const sent: Sent[] = [];
        const controller = new AbortController();
        const yielded: string[] = [];

        const error = await rejection(
            (async () => {
                for await (const chunk of decisions(sent, (number) => {
                    if (number === 2) {
                        controller.abort();
                        throw new Error("The operation was aborted.");
                    }
                    return succeeded(number);
                }).iterCreateChunked(
                    { request: REQUEST, file: wav(3000), maxChunkMs: 1000 },
                    { abortSignal: controller.signal },
                )) {
                    yielded.push(chunk.status);
                }
            })(),
        );

        expectAbortError(error);
        expect(yielded).toEqual(["succeeded"]);
        expect(sent).toHaveLength(2);
    });
});

describe("resumeMs", () => {
    it("resumes at the chunk that stopped the job and sends those after it", async () => {
        const audio = wav(4000);
        const stopped = await decisions(
            [],
            failingAt(2, () => failed(402, "payment_required")),
        ).createChunked({ request: REQUEST, file: audio, maxChunkMs: 1000 });
        const sent: Sent[] = [];

        const resumed = await decisions(sent).createChunked({
            request: REQUEST,
            file: audio,
            maxChunkMs: 1000,
            startMs: stopped.resumeMs,
        });

        expect(stopped.resumeMs).toBe(1000);
        expect(times(resumed.chunks)).toEqual([
            [1000, 2000],
            [2000, 3000],
            [3000, 4000],
        ]);
        expect(resumed.complete).toBe(true);
    });

    it("resumes an MP3 job with the same chunks as the job that stopped", async () => {
        // Each chunk of this file starts with frames repeated from the chunk before it, so resuming where
        // the stopped chunk starts would send those frames again in a chunk of its own.
        const audio = asset("tone_mpeg25_8k.mp3");
        const stopped = await decisions(
            [],
            failingAt(3, () => failed(402, "payment_required")),
        ).createChunked({ request: REQUEST, file: audio, maxChunkMs: 1000 });

        const resumed = await decisions([]).createChunked({
            request: REQUEST,
            file: audio,
            maxChunkMs: 1000,
            startMs: stopped.resumeMs,
        });

        expect(stopped.resumeMs).toBe(1446);
        expect(times(resumed.chunks)).toEqual(times(stopped.chunks.slice(2)));
        expect(resumed.complete).toBe(true);
    });

    it("passes over a chunk that could not be decoded before the chunk that stopped the job", async () => {
        const result = await decisions([], (number) => {
            if (number === 2) {
                return failed(400, "audio_decode_failed");
            }
            if (number === 3) {
                return failed(402, "payment_required");
            }
            return succeeded(number);
        }).createChunked({ request: REQUEST, file: wav(5000), maxChunkMs: 1000 });

        expect(statuses(result.chunks)).toEqual(["succeeded", "failed", "failed", "not_attempted", "not_attempted"]);
        expect(result.resumeMs).toBe(2000);
    });

    it.each<[string, Respond]>([
        ["complete", succeeded],
        ["only a chunk that could not be decoded failed", failingAt(2, () => failed(400, "audio_decode_failed"))],
    ])("is undefined when no chunk stopped the job: %s", async (_name, respond) => {
        const result = await decisions([], respond).createChunked({
            request: REQUEST,
            file: wav(3000),
            maxChunkMs: 1000,
        });

        expect(result.resumeMs).toBeUndefined();
    });

    it.each<[number | undefined, number]>([
        [undefined, 0],
        [1500, 1500],
    ])("is the job's start when an MP3 job with startMs %s stops at its first chunk", async (startMs, resumeMs) => {
        // The first chunk starts with frames from before the job's start, and before 0 when the encoder
        // added samples before the recording, so its startMs is earlier than where the job started.
        const audio = asset("tone_mpeg25_8k.mp3");
        const stopped = await decisions([], () => failed(402, "payment_required")).createChunked({
            request: REQUEST,
            file: audio,
            maxChunkMs: 1000,
            startMs,
        });

        const resumed = await decisions([]).createChunked({
            request: REQUEST,
            file: audio,
            maxChunkMs: 1000,
            startMs: stopped.resumeMs,
        });

        expect(stopped.chunks[0].startMs).toBeLessThan(resumeMs);
        expect(stopped.resumeMs).toBe(resumeMs);
        expect(times(resumed.chunks)).toEqual(times(stopped.chunks));
    });

    it("is 0 for a result built from iterator results with no startMs when the first chunk stopped the job", async () => {
        const yielded = await collect(
            decisions([], () => failed(402, "payment_required")).iterCreateChunked({
                request: REQUEST,
                file: wav(3000),
                maxChunkMs: 1000,
            }),
        );

        const result = new ChunkedDecisionsResult(yielded);

        expect(result.startMs).toBe(0);
        expect(result.resumeMs).toBe(0);
    });

    it("finds where to resume in results built without the fields that do not apply to them", () => {
        const result = new ChunkedDecisionsResult(
            [
                {
                    index: 0,
                    startMs: 1000,
                    endMs: 2000,
                    status: "failed",
                    error: new DecisionsError({ statusCode: 402 }),
                },
                { index: 1, startMs: 2000, endMs: 3000, status: "not_attempted" },
            ],
            1000,
        );

        expect(result.responses).toEqual([undefined, undefined]);
        expect(result.resumeMs).toBe(1000);
    });

    it("rejects a startMs that is not a safe integer when a result is built", () => {
        expectError(
            thrownBy(() => new ChunkedDecisionsResult([], 1.5)),
            TypeError,
            "startMs must be a safe integer",
        );
    });
});

describe("create", () => {
    it.each<DownmixStrategy>([
        "mix",
        "first_channel",
        "none",
    ])("sends a WAV file mixed down as iterAudioChunks mixes it with downmixStrategy %s", async (downmixStrategy) => {
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });

        const sent = await uploaded(audio, downmixStrategy);

        const [expected] = await collect(iterAudioChunks(audio, { maxChunkMs: 300_000, downmixStrategy }));
        expectBytes([sent], [expected.data]);
        expect(Buffer.compare(sent, audio) === 0).toBe(downmixStrategy === "none");
    });

    it("mixes down by default", async () => {
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });

        const [expected] = await collect(iterAudioChunks(audio, { maxChunkMs: 300_000 }));
        expectBytes([await uploaded(audio)], [expected.data]);
    });

    it("mixes down a WAV stream given with its filename and content type", async () => {
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });
        const sent: Sent[] = [];

        await decisions(sent).create({
            request: REQUEST,
            file: { data: new Blob([audio]).stream(), filename: "call.wav", contentType: "audio/wav" },
        });

        const [expected] = await collect(iterAudioChunks(audio, { maxChunkMs: 300_000 }));
        expectBytes([await fileBytes(sent[0])], [expected.data]);
        expect([filePart(sent[0]).name, filePart(sent[0]).type]).toEqual(["call.wav", "audio/wav"]);
    });

    it("sends the mixed-down file through withRawResponse", async () => {
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });
        const sent: Sent[] = [];

        const { data } = await decisions(sent).create({ request: REQUEST, file: audio }).withRawResponse();

        const [expected] = await collect(iterAudioChunks(audio, { maxChunkMs: 300_000 }));
        expectBytes([await fileBytes(sent[0])], [expected.data]);
        expect(data.runId).toBe("run-1");
    });

    it("sends an MP3 file as it is", async () => {
        const audio = asset("tone_mpeg1_32k.mp3");

        expectBytes([await uploaded(audio)], [audio]);
    });

    it("sends a stream it could not mix down as it is, although the stream cannot be read again", async () => {
        const audio = asset("tone_mpeg1_32k.mp3");
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(audio.slice(0, 1000));
                controller.enqueue(audio.slice(1000));
                controller.close();
            },
        });

        expectBytes([await uploaded(stream)], [audio]);
    });

    it("sends a WAV file it cannot read as it is", async () => {
        const audio = wav(2500, { sampleRate: 48000, channels: 2 });
        // A compressed format tag, which the API may still decode.
        new DataView(audio.buffer).setUint16(20, 2, true);

        expectBytes([await uploaded(audio)], [audio]);
    });

    it.each<[string, () => Uint8Array]>([
        ["a stereo MP3 file", STEREO_MP3],
        ["an MP3 file that turns from mono to stereo partway", MONO_THEN_STEREO_MP3],
    ])("rejects first_channel for %s from every entry point, sending nothing", async (_, file) => {
        const sent: Sent[] = [];
        const audio = file();
        const options = { maxChunkMs: 1000, downmixStrategy: "first_channel" } as const;

        const errors = [
            await rejection(
                decisions(sent).create({ request: REQUEST, file: audio, downmixStrategy: "first_channel" }),
            ),
            await iterationError(decisions(sent).iterCreateChunked({ request: REQUEST, file: audio, ...options })),
            await iterationError(iterAudioChunks(audio, options)),
            thrownBy(() => checkDownmix(audio, "first_channel")),
        ];

        for (const error of errors) {
            expectError(error, UnsupportedAudioError, "cannot keep only the first channel of this 2-channel MP3 file");
            expect(error.message).toContain("pan=mono|c0=c0");
        }
        expect(sent).toEqual([]);
    });

    it.each<[string, () => Uint8Array, string]>([
        ["a stereo μ-law WAV file", STEREO_MULAW, "2-channel WAV file the SDK cannot read"],
        ["a FLAC file", FLAC, "file that is neither WAV nor MP3"],
    ])("rejects first_channel for %s, which create would send as it is, sending nothing", async (_, file, says) => {
        const sent: Sent[] = [];
        const audio = file();

        const errors = [
            await rejection(
                decisions(sent).create({ request: REQUEST, file: audio, downmixStrategy: "first_channel" }),
            ),
            thrownBy(() => checkDownmix(audio, "first_channel")),
        ];

        for (const error of errors) {
            expectError(error, UnsupportedAudioError, `cannot keep only the first channel of this ${says}`);
        }
        expect(sent).toEqual([]);
    });

    it("rejects first_channel for an MP3 file it cannot read with the reason, sending nothing", async () => {
        const sent: Sent[] = [];
        const audio = MONO_AND_STEREO_MP3();

        const errors = [
            await rejection(
                decisions(sent).create({ request: REQUEST, file: audio, downmixStrategy: "first_channel" }),
            ),
            thrownBy(() => checkDownmix(audio, "first_channel")),
        ];

        for (const error of errors) {
            expectError(error, UnsupportedAudioError, "audio frames follow a tag at byte 16512");
        }
        expect(sent).toEqual([]);
    });

    it("sends a mono μ-law WAV file as it is under first_channel, since it has one channel", async () => {
        const audio = MONO_MULAW();

        expect(() => checkDownmix(audio, "first_channel")).not.toThrow();
        expectBytes([await uploaded(audio, "first_channel")], [audio]);
    });

    it.each(
        MONO_MP3_ENDINGS,
    )("sends a mono MP3 file ending in %s only up to its last whole frame under first_channel", async (_, kept, ending) => {
        const audio = bytes(kept(), ending());

        expect(() => checkDownmix(audio, "first_channel")).not.toThrow();
        expectBytes([await uploaded(audio, "first_channel")], [kept()]);
    });

    it.each(
        MONO_MP3_ENDINGS,
    )("chunks a mono MP3 file ending in %s under first_channel, leaving out what follows its frames", async (_, kept, ending) => {
        const audio = bytes(kept(), ending());

        const chunks = await collect(iterAudioChunks(audio, { maxChunkMs: 300_000, downmixStrategy: "first_channel" }));

        expectBytes(
            chunks.map((chunk) => chunk.data),
            [MONO_MP3_FRAMES()],
        );
    });

    describe.each<[string, DownmixStrategy | undefined]>([
        ["by default", undefined],
        ["with downmixStrategy none", "none"],
    ])("%s", (_, downmixStrategy) => {
        it.each<[string, () => Uint8Array]>([
            ["a stereo MP3 file", STEREO_MP3],
            ["an MP3 file that turns from mono to stereo partway", MONO_THEN_STEREO_MP3],
            ["a stereo μ-law WAV file", STEREO_MULAW],
            ["a mono μ-law WAV file", MONO_MULAW],
            ["a FLAC file", FLAC],
        ])("sends %s unchanged", async (_, file) => {
            const audio = file();

            expect(() => checkDownmix(audio, downmixStrategy)).not.toThrow();
            expectBytes([await uploaded(audio, downmixStrategy)], [audio]);
        });
    });

    it("rejects a file given as a string, pointing to { path }, sending nothing", async () => {
        const sent: Sent[] = [];

        const error = await rejection(
            decisions(sent).create({
                request: REQUEST,
                file: "call.wav" as unknown as Decisions.DecisionsUpload["file"],
            }),
        );

        expectError(error, TypeError, 'pass { path: "call.wav" }');
        expect(sent).toEqual([]);
    });

    it("rejects a downmixStrategy other than mix, first_channel or none, sending nothing", async () => {
        const sent: Sent[] = [];

        const error = await rejection(
            decisions(sent).create({
                request: REQUEST,
                file: wav(100),
                downmixStrategy: "average" as DownmixStrategy,
            }),
        );

        expectError(error, RangeError, "downmixStrategy");
        expect(sent).toEqual([]);
    });
});

describe("aborting during the mixdown", () => {
    // Resampling 10 seconds at 48 kHz takes about 20 blocks of work.
    const audio = samplesWav(new Float64Array(48000 * 10), { channels: 1, sampleRate: 48000 });

    it.each<[string, (client: DecisionsClient["decisions"], signal: AbortSignal) => Promise<unknown>]>([
        ["create", (client, abortSignal) => client.create({ request: REQUEST, file: audio }, { abortSignal })],
        [
            "createChunked",
            (client, abortSignal) =>
                client.createChunked({ request: REQUEST, file: audio, maxChunkMs: 300_000 }, { abortSignal }),
        ],
    ])("rejects %s with the abort error without finishing the mixdown or sending anything", async (_name, call) => {
        // Every read of the clock moves it a second on, so the mixdown pauses after each block of work
        // however fast it runs. The second read is the one after the first block that decides to pause,
        // so aborting there means the mixdown should stop at that pause without reading the clock again.
        const readsAtAbort = 2;
        const sent: Sent[] = [];
        const controller = new AbortController();
        let clockReads = 0;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => {
            clockReads += 1;
            if (clockReads === readsAtAbort) {
                controller.abort();
            }
            return clockReads * 1000;
        });

        let error: Error;
        try {
            error = await rejection(call(decisions(sent), controller.signal));
        } finally {
            clock.mockRestore();
        }

        expectAbortError(error);
        expect(clockReads).toBe(readsAtAbort);
        expect(sent).toEqual([]);
    });
});
