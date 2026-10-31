// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

export function checkInteger(name: string, value: unknown): number {
    // Arithmetic on larger numbers is not exact, and the bounds checked later assume it is.
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`${name} must be a safe integer, got ${describe(value)}.`);
    }
    return value;
}

export function checkChoice<T>(name: string, value: unknown, choices: readonly T[]): T {
    if (!isOneOf(value, choices)) {
        const quoted = choices.map(describe);
        throw new RangeError(
            `${name} must be ${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}, got ${describe(value)}.`,
        );
    }
    return value;
}

function isOneOf<T>(value: unknown, choices: readonly T[]): value is T {
    return (choices as readonly unknown[]).includes(value);
}

function describe(value: unknown): string {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
}
