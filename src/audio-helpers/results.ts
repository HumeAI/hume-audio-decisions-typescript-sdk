// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { BadRequestError } from "../api/errors/BadRequestError.js";
import type { DecisionsUpload } from "../api/resources/decisions/client/requests/DecisionsUpload.js";
import type { DecisionsRequest } from "../api/types/DecisionsRequest.js";
import type { DecisionsResponse } from "../api/types/DecisionsResponse.js";
import { ParseError } from "../core/schemas/index.js";
import { DecisionsError } from "../errors/DecisionsError.js";
import { checkInteger } from "./checks.js";
import { type iterAudioChunks, type PlannedRecording, prepareChunks } from "./chunks.js";
import type { DownmixOptions } from "./files.js";

interface ChunkPosition {
    /** Position of the chunk in the recording, starting at 0. */
    readonly index: number;
    /**
     * Where the chunk starts in the recording, in milliseconds. A span's `audioStartMs` and
     * `audioEndMs` are measured from the start of the chunk, so add this to place the span in the
     * recording. The first chunk of an MP3 file can start a few tens of milliseconds before 0.
     */
    readonly startMs: number;
    /** Where the chunk ends in the recording, in milliseconds. */
    readonly endMs: number;
}

interface SucceededChunk extends ChunkPosition {
    readonly status: "succeeded";
    /** The API's response for the chunk, unchanged. */
    readonly response: DecisionsResponse;
    readonly error?: undefined;
}

interface FailedChunk extends ChunkPosition {
    readonly status: "failed";
    readonly response?: undefined;
    /**
     * The error the request threw. When the response's body could not be read, a DecisionsError with
     * no status code whose `cause` holds the parse error.
     */
    readonly error: DecisionsError;
}

interface NotAttemptedChunk extends ChunkPosition {
    /** No request was sent for the chunk, so it was not billed. */
    readonly status: "not_attempted";
    readonly response?: undefined;
    readonly error?: undefined;
}

/** The outcome of one chunk's request. Checking `status` narrows it to the chunk's response or error. */
export type ChunkResult = SucceededChunk | FailedChunk | NotAttemptedChunk;

export type ChunkStatus = ChunkResult["status"];

/** The outcome of every chunk's request, in the order of the chunks. */
export class ChunkedDecisionsResult {
    /** One result for each chunk of the requested range. */
    public readonly chunks: readonly ChunkResult[];
    /** The `startMs` the job was given, or 0 when it was given none. */
    public readonly startMs: number;

    /**
     * @param chunks The results of a job, such as those collected from `iterCreateChunked`, in order.
     * @param startMs The `startMs` the job was given.
     * @throws {TypeError} If `startMs` is not a safe integer.
     */
    constructor(chunks: Iterable<ChunkResult>, startMs?: number) {
        this.startMs = startMs === undefined ? 0 : checkInteger("startMs", startMs);
        this.chunks = Object.freeze(Array.from(chunks));
    }

    /** Each chunk's response, or undefined for a chunk without one, in the order of the chunks. */
    public get responses(): (DecisionsResponse | undefined)[] {
        return this.chunks.map((chunk) => chunk.response);
    }

    /** Whether every chunk's request succeeded. */
    public get complete(): boolean {
        return this.chunks.every((chunk) => chunk.status === "succeeded");
    }

    /**
     * The `startMs` to give a new job, with the same `endMs`, so that it sends again the audio from
     * the chunk that stopped this job to the end. Earlier chunks that failed because their audio could
     * not be decoded are not sent again. A WAV chunk's `endMs` is rounded to the millisecond, so the
     * new job can skip or repeat a few samples where it starts. Undefined when no chunk stopped the job.
     */
    public get resumeMs(): number | undefined {
        const rule = new StopRule();
        for (let position = 0; position < this.chunks.length; position++) {
            rule.record(this.chunks[position]);
            if (rule.stopped) {
                // An MP3 chunk's startMs includes frames repeated from before it, so resuming there
                // would send those again as new audio.
                return position > 0 ? this.chunks[position - 1].endMs : this.startMs;
            }
        }
        return undefined;
    }
}

type Create = (upload: DecisionsUpload & DownmixOptions) => Promise<DecisionsResponse>;

/**
 * Sends each chunk of `upload.file` with `create`, as `iterCreateChunked` describes. The options are
 * checked by this call, and the file when iteration starts.
 */
export function sendChunks(
    create: Create,
    { request, file, ...options }: DecisionsUpload & iterAudioChunks.Options,
    signal: AbortSignal | undefined,
): AsyncGenerator<ChunkResult, void, undefined> {
    return send(create, request, prepareChunks(file, options), signal);
}

async function* send(
    create: Create,
    request: DecisionsRequest,
    planRecording: (signal?: AbortSignal) => Promise<PlannedRecording>,
    signal: AbortSignal | undefined,
): AsyncGenerator<ChunkResult, void, undefined> {
    // Planning reads and checks the whole file, so a file that cannot be split is rejected before
    // any request is sent.
    const { filename, contentType, chunks } = await planRecording(signal);
    const rule = new StopRule();
    // A chunk's data is copied only when it is sent, so the chunks after a stop cost nothing.
    for (const chunk of chunks) {
        const position = { index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs };
        let result: ChunkResult = { ...position, status: "not_attempted" };
        if (!rule.stopped) {
            try {
                const response = await create({
                    request,
                    file: { data: chunk.build(), filename, contentType },
                    // The chunks were mixed down when they were planned.
                    downmixStrategy: "none",
                });
                result = { ...position, status: "succeeded", response };
            } catch (raised) {
                // An abort ends the job rather than failing one chunk. Anything other than a
                // DecisionsError did not come from the request, so it is not a chunk's outcome either,
                // except a ParseError: the generated client throws one when a response body is not the
                // JSON it expects for the status, such as a proxy's HTML error page, and the status is
                // lost with it.
                if (signal?.aborted || !(raised instanceof DecisionsError || raised instanceof ParseError)) {
                    throw raised;
                }
                const error =
                    raised instanceof ParseError
                        ? new DecisionsError({ message: "The API's response could not be read.", cause: raised })
                        : raised;
                result = { ...position, status: "failed", error };
            }
        }
        rule.record(result);
        yield result;
    }
}

/** Collects the results of `iterCreateChunked` for `createChunked`. */
export async function collectResults(
    results: AsyncIterable<ChunkResult>,
    startMs: number | undefined,
): Promise<ChunkedDecisionsResult> {
    const collected: ChunkResult[] = [];
    for await (const result of results) {
        collected.push(result);
    }
    return new ChunkedDecisionsResult(collected, startMs);
}

// Sending chunks and finding resumeMs in a finished result must agree on which chunk stopped the job,
// so both feed the chunks through this in order.
class StopRule {
    private _stopped = false;
    private anySucceeded = false;

    public get stopped(): boolean {
        return this._stopped;
    }

    public record(chunk: ChunkResult): void {
        // A decode failure can come from one damaged stretch of the recording, but until some chunk has
        // decoded, the whole file is the likelier cause and every remaining chunk would fail the same
        // way. Any other error, including codes the API adds later, is assumed to fail every remaining
        // chunk, so sending them would only spend requests. The generated client has already retried
        // rate limits and server errors before throwing.
        const failsAlone =
            this.anySucceeded &&
            chunk.error instanceof BadRequestError &&
            chunk.error.body.code === "audio_decode_failed";
        if (chunk.status === "failed" && !failsAlone) {
            this._stopped = true;
        }
        this.anySucceeded ||= chunk.status === "succeeded";
    }
}
