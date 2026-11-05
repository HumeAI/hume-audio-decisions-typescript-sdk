// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import type { DecisionsUpload } from "../api/resources/decisions/client/requests/DecisionsUpload.js";
import { toMultipartDataPart, type Uploadable } from "../core/file/index.js";
import { checkDownmixStrategy, type DownmixStrategy, downmixWav, sendingOf } from "./downmix.js";
import { wavChunk } from "./wav.js";

interface ReadFile {
    readonly data: Uint8Array;
    readonly filename: string | undefined;
    readonly contentType: string | undefined;
}

export interface DownmixOptions {
    /**
     * How a WAV file is mixed down before it is sent: "mix", the default, mixes it the way the API
     * does, so the model hears the same audio; "first_channel" keeps only the first channel; and
     * "none" sends it as it is. The SDK cannot take a channel out of MP3 files, WAV files it cannot
     * read, or files of other formats, so it sends them as they are, and "first_channel" rejects such
     * a file with an UnsupportedAudioError, sending nothing, unless it can tell the file has only one
     * channel. It then sends a mono MP3 file only up to the end of its last whole frame, leaving out
     * tags and any other bytes after it. `checkDownmix` in `@humeai/audio-decisions/audio-helpers`
     * finds this before sending.
     * Unless it is "none", `create` reads the whole file into memory before sending it, since it must
     * read the file to tell whether it is a WAV file. `iterAudioChunks` in `@humeai/audio-decisions/audio-helpers` describes each.
     */
    downmixStrategy?: DownmixStrategy;
}

export function checkFile(file: Uploadable): void {
    if (typeof file === "string") {
        throw new TypeError(
            `file must be the audio's contents or { path }, got a string. To read a file from disk, pass { path: ${JSON.stringify(file)} }.`,
        );
    }
}

/** The file's contents, with the filename and content type its upload would carry. */
export async function readFile(file: Uploadable): Promise<ReadFile> {
    // Resolved the way `create` resolves an upload, so chunks carry the same filename and content
    // type, and a path is opened through the same file system access.
    const { data, filename, contentType } = await toMultipartDataPart(file);
    return { data: await readBytes(data), filename, contentType };
}

/**
 * `upload` with a WAV recording mixed down as `downmixStrategy` asks, to send with `create`. Rejects
 * with a DecisionsError if `signal` aborts during the mixdown.
 */
export async function downmixUpload(
    { downmixStrategy, ...upload }: DecisionsUpload & DownmixOptions,
    signal?: AbortSignal,
): Promise<DecisionsUpload> {
    const strategy = checkDownmixStrategy(downmixStrategy);
    if (strategy === "none") {
        return upload;
    }
    checkFile(upload.file);
    const { data, filename, contentType } = await readFile(upload.file);
    // A stream that has been read cannot always be read again, so what was read is sent instead.
    return { ...upload, file: { data: await downmixFile(data, strategy, signal), filename, contentType } };
}

async function downmixFile(
    data: Uint8Array,
    strategy: DownmixStrategy,
    signal: AbortSignal | undefined,
): Promise<Uint8Array> {
    const sending = sendingOf(data, strategy);
    const mixed = sending.wav === undefined ? undefined : await downmixWav(sending.data, sending.wav, strategy, signal);
    return mixed === undefined ? sending.data : wavChunk(mixed.data, mixed.wav, 0, mixed.wav.sampleCount);
}

async function readBytes(data: Uploadable.FileLike): Promise<Uint8Array> {
    if (ArrayBuffer.isView(data)) {
        return asUint8Array(data);
    }
    if (
        data instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)
    ) {
        return new Uint8Array(data);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
        return new Uint8Array(await data.arrayBuffer());
    }
    if (isReadableStream(data)) {
        return concat(await readStream(data));
    }
    if (isAsyncIterable(data)) {
        // Node's Readable streams, which are read without importing the stream module.
        const pieces: Uint8Array[] = [];
        for await (const piece of data) {
            pieces.push(toBytes(piece));
        }
        return concat(pieces);
    }
    throw new TypeError(
        "file must be a Blob, a stream, an ArrayBuffer or a typed array, { path } or { data } holding one of those.",
    );
}

async function readStream(stream: ReadableStream<unknown>): Promise<Uint8Array[]> {
    const reader = stream.getReader();
    const pieces: Uint8Array[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return pieces;
            }
            pieces.push(toBytes(value));
        }
    } finally {
        reader.releaseLock();
    }
}

function toBytes(piece: unknown): Uint8Array {
    if (ArrayBuffer.isView(piece)) {
        return asUint8Array(piece);
    }
    // A stream given an encoding has already decoded the audio as text, which cannot be turned back
    // into the same bytes.
    throw new TypeError(`file must be a stream of bytes, got a stream holding ${typeof piece} values.`);
}

function asUint8Array(view: ArrayBufferView): Uint8Array {
    // A plain Uint8Array even for Node's Buffer, whose slice returns a view rather than a copy.
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function concat(pieces: Uint8Array[]): Uint8Array {
    if (pieces.length === 1) {
        return pieces[0];
    }
    let length = 0;
    for (const piece of pieces) {
        length += piece.length;
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) {
        data.set(piece, offset);
        offset += piece.length;
    }
    return data;
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
    return typeof value === "object" && value !== null && typeof (value as ReadableStream).getReader === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    );
}
