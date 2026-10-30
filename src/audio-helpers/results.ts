// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { BadRequestError } from "../api/errors/BadRequestError.js";
import type { DecisionsUpload } from "../api/resources/decisions/client/requests/DecisionsUpload.js";
import type { DecisionsRequest } from "../api/types/DecisionsRequest.js";
import type { DecisionsResponse } from "../api/types/DecisionsResponse.js";
import type { Uploadable } from "../core/file/index.js";
import { DecisionsError } from "../errors/DecisionsError.js";
import { type ChunkOptions, checkChunkOptions, type iterAudioChunks, planAudioChunks } from "./chunks.js";
import { checkFile, readFile } from "./files.js";
import { checkInteger } from "./integers.js";

export type ChunkStatus = "succeeded" | "failed" | "not_attempted";

/** The outcome of one chunk's request. */
export class ChunkResult {
    /** Position of the chunk in the recording, starting at 0. */
    public readonly index: number;
    /**
     * Where the chunk starts in the recording, in milliseconds. A moment's `audio_start_ms` and
     * `audio_end_ms` are measured from the start of the chunk, so add this to place the moment in the
     * recording. The first chunk of an MP3 file can start a few tens of milliseconds before 0.
     */
    public readonly startMs: number;
    /** Where the chunk ends in the recording, in milliseconds. */
    public readonly endMs: number;
    /** The API's response for the chunk, unchanged, when the request succeeded. */
    public readonly response: DecisionsResponse | undefined;
    /**
     * The error the request threw, when it failed. Undefined when the request succeeded or was never
     * sent.
     */
    public readonly error: DecisionsError | undefined;

    constructor(
        index: number,
        startMs: number,
        endMs: number,
        response: DecisionsResponse | undefined,
        error: DecisionsError | undefined,
    ) {
        this.index = index;
        this.startMs = startMs;
        this.endMs = endMs;
        this.response = response;
        this.error = error;
    }

    public get status(): ChunkStatus {
        if (this.response !== undefined) {
            return "succeeded";
        }
        if (this.error !== undefined) {
            return "failed";
        }
        return "not_attempted";
    }
}

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
        return this.chunks.every((chunk) => chunk.response !== undefined);
    }

    /**
     * The `startMs` to give a new job, with the same `endMs`, so that it sends again the audio from
     * the chunk that stopped this job to the end. Earlier chunks that failed because their audio could
     * not be decoded are not sent again. Null when no chunk stopped the job.
     */
    public get resumeMs(): number | null {
        const rule = new StopRule();
        for (let position = 0; position < this.chunks.length; position++) {
            rule.record(this.chunks[position]);
            if (rule.stopped) {
                // An MP3 chunk's startMs includes frames repeated from before it, so resuming there
                // would send those again as new audio.
                return position > 0 ? this.chunks[position - 1].endMs : this.startMs;
            }
        }
        return null;
    }
}

/**
 * Sends each chunk of `upload.file` with `create`, as `iterCreateChunked` describes. The options are
 * checked by this call, and the file when iteration starts.
 */
export function sendChunks(
    create: (upload: DecisionsUpload) => Promise<DecisionsResponse>,
    { request, file, ...options }: DecisionsUpload & iterAudioChunks.Options,
    signal: AbortSignal | undefined,
): AsyncGenerator<ChunkResult, void, undefined> {
    const checked = checkChunkOptions(options);
    checkFile(file);
    return send(create, request, file, checked, signal);
}

async function* send(
    create: (upload: DecisionsUpload) => Promise<DecisionsResponse>,
    request: DecisionsRequest,
    file: Uploadable,
    options: ChunkOptions,
    signal: AbortSignal | undefined,
): AsyncGenerator<ChunkResult, void, undefined> {
    // Planning reads and checks the whole file, so a file that cannot be split is rejected before
    // any request is sent.
    const { data, filename, contentType } = await readFile(file);
    const chunks = await planAudioChunks(data, options, signal);
    const rule = new StopRule();
    // A chunk's data is copied only when it is sent, so the chunks after a stop cost nothing.
    for (const chunk of chunks) {
        let response: DecisionsResponse | undefined;
        let error: DecisionsError | undefined;
        if (!rule.stopped) {
            try {
                response = await create({ request, file: { data: chunk.build(), filename, contentType } });
            } catch (raised) {
                // An abort ends the job rather than failing one chunk. Anything other than a
                // DecisionsError did not come from the request, so it is not a chunk's outcome either.
                if (!(raised instanceof DecisionsError) || signal?.aborted) {
                    throw raised;
                }
                error = raised;
            }
        }
        const result = new ChunkResult(chunk.index, chunk.startMs, chunk.endMs, response, error);
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
    public stopped = false;
    private anySucceeded = false;

    public record(chunk: ChunkResult): void {
        if (chunk.error !== undefined && !failsOnlyThisChunk(chunk.error, this.anySucceeded)) {
            this.stopped = true;
        }
        this.anySucceeded = this.anySucceeded || chunk.response !== undefined;
    }
}

function failsOnlyThisChunk(error: DecisionsError, afterSuccess: boolean): boolean {
    // A decode failure can come from one damaged stretch of the recording, but until some chunk has
    // decoded, the whole file is the likelier cause and every remaining chunk would fail the same way.
    // Any other error, including codes the API adds later, is assumed to fail every remaining chunk,
    // so sending them would only spend requests. The generated client has already retried rate limits
    // and server errors before throwing.
    const decodeFailed = error instanceof BadRequestError && error.body.code === "audio_decode_failed";
    return decodeFailed && afterSuccess;
}
