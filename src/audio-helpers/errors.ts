// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

/** The recording cannot be split into chunks, because it is empty or not a file the helpers support. */
export class UnsupportedAudioError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsupportedAudioError";
    }
}
