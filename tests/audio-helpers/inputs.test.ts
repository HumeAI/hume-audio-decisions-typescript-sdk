// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { iterAudioChunks } from "../../src/audio-helpers/index";
import type { Uploadable } from "../../src/core/file/index";
import { bytes, collect, expectError, iterationError, pcm, thrownBy, wavFile } from "./audioFiles";

const recording = wavFile({ sampleRate: 16000, channels: 1, sampleWidth: 2, data: pcm(2500 * 16 * 2) });
// Two MPEG-1 frames of 417 bytes, so the chunk is a slice of the recording's bytes.
const mp3 = bytes(...[0, 1].map(() => bytes([0xff, 0xfb, 0x90, 0x00], new Uint8Array(413))));

function pieces(data: Uint8Array): Uint8Array[] {
    return [data.slice(0, 1000), data.slice(1000, 50_000), data.slice(50_000)];
}

function chunksOf(file: Uploadable): Promise<unknown[]> {
    return collect(iterAudioChunks(file, { maxChunkMs: 1000 }));
}

describe("iterAudioChunks inputs", () => {
    let directory: string;

    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), "audio-helpers-"));
    });

    afterAll(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it.each<[string, () => Uploadable]>([
        ["an ArrayBuffer", () => recording.slice().buffer],
        ["a DataView partway into a larger buffer", () => new DataView(bytes([1, 2, 3], recording).buffer, 3)],
        ["a Node Buffer", () => Buffer.from(recording)],
        ["a Blob", () => new Blob([recording])],
        ["a Node Readable", () => Readable.from(pieces(recording))],
        [
            "a web ReadableStream",
            () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const piece of pieces(recording)) {
                            controller.enqueue(piece);
                        }
                        controller.close();
                    },
                }),
        ],
        [
            "{ data, filename, contentType }",
            () => ({ data: recording, filename: "call.wav", contentType: "audio/wav" }),
        ],
    ])("gives the same chunks from %s as from its bytes", async (_, file) => {
        expect(await chunksOf(file())).toEqual(await chunksOf(recording));
    });

    it("gives the same chunks from { path } and from a file stream as from its bytes", async () => {
        const path = join(directory, "call.wav");
        writeFileSync(path, recording);

        expect(await chunksOf({ path })).toEqual(await chunksOf(recording));
        expect(await chunksOf(createReadStream(path))).toEqual(await chunksOf(recording));
    });

    it("copies each chunk rather than sharing the memory of a Node Buffer", async () => {
        const source = Buffer.from(mp3);

        const [chunk] = await collect(iterAudioChunks(source, { maxChunkMs: 1000 }));
        source.fill(0);

        expect(chunk.data.constructor).toBe(Uint8Array);
        expect(chunk.data).toEqual(mp3);
    });

    it("rejects a file given as a string from the call, pointing to { path }", () => {
        const error = thrownBy(() => iterAudioChunks("call.wav" as unknown as Uploadable, { maxChunkMs: 1000 }));

        expectError(error, TypeError, 'To read a file from disk, pass { path: "call.wav" }.');
    });

    it("rejects data of a type it cannot read, listing the types it can", async () => {
        const error = await iterationError(
            iterAudioChunks({ data: 42 } as unknown as Uploadable, { maxChunkMs: 1000 }),
        );

        expectError(error, TypeError, "file must be a Blob, a stream, an ArrayBuffer or a typed array");
    });

    it("rejects a stream that yields text rather than bytes", async () => {
        const error = await iterationError(iterAudioChunks(Readable.from(["RIFF"]), { maxChunkMs: 1000 }));

        expectError(error, TypeError, "file must be a stream of bytes, got a stream holding string values.");
    });
});
