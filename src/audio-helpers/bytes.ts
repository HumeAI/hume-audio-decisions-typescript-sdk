// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

export function dataView(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Whether the bytes at `offset` spell `text`, which is ASCII. False when they run past the end. */
export function hasBytes(data: Uint8Array, offset: number, text: string): boolean {
    if (offset < 0 || offset + text.length > data.length) {
        return false;
    }
    for (let index = 0; index < text.length; index++) {
        if (data[offset + index] !== text.charCodeAt(index)) {
            return false;
        }
    }
    return true;
}

export function writeAscii(data: Uint8Array, offset: number, text: string): void {
    for (let index = 0; index < text.length; index++) {
        data[offset + index] = text.charCodeAt(index);
    }
}

/** The big-endian integer in the up to 4 bytes from `offset` that lie within `data`. */
export function uint32BE(data: Uint8Array, offset: number): number {
    let value = 0;
    for (let index = offset; index < Math.min(offset + 4, data.length); index++) {
        value = value * 256 + data[index];
    }
    return value;
}
