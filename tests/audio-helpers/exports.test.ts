// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { readFileSync } from "fs";
import { join } from "path";

describe("package exports", () => {
    // package.json is generated, so this fails if a regeneration drops the hand-made subpath.
    it("exports the audio helpers from the audio-helpers subpath", () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));

        expect(manifest.exports["./audio-helpers"]).toEqual({
            import: {
                types: "./dist/esm/audio-helpers/index.d.mts",
                default: "./dist/esm/audio-helpers/index.mjs",
            },
            require: {
                types: "./dist/cjs/audio-helpers/index.d.ts",
                default: "./dist/cjs/audio-helpers/index.js",
            },
            default: "./dist/cjs/audio-helpers/index.js",
        });
    });
});
