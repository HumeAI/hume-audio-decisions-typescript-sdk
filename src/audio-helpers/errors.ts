// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/**
 * The recording cannot be handled as asked: it cannot be split into chunks, because it is empty or
 * not a file the helpers support, or `create`, `createChunked` and `iterAudioChunks` cannot keep only
 * its first channel as downmixStrategy "first_channel" asks.
 */
export class UnsupportedAudioError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsupportedAudioError";
    }
}
