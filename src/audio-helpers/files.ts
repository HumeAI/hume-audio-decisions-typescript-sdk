// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { toMultipartDataPart, type Uploadable } from "../core/file/index.js";

export interface ReadFile {
    readonly data: Uint8Array;
    readonly filename: string | undefined;
    readonly contentType: string | undefined;
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

async function readBytes(data: unknown): Promise<Uint8Array> {
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
