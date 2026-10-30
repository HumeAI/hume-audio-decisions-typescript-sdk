// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

// Callers keep every operand, and the quotient times the denominator, within Number.MAX_SAFE_INTEGER.
export function floorDiv(numerator: number, denominator: number): number {
    // Floating-point division can round a quotient that falls just short of an integer up to that
    // integer, so the remainder corrects it.
    let quotient = Math.floor(numerator / denominator);
    const remainder = numerator - quotient * denominator;
    if (remainder < 0) {
        quotient -= 1;
    } else if (remainder >= denominator) {
        quotient += 1;
    }
    return quotient;
}

export function roundDiv(numerator: number, denominator: number): number {
    return floorDiv(2 * numerator + denominator, 2 * denominator);
}

export function ceilDiv(numerator: number, denominator: number): number {
    return -floorDiv(-numerator, denominator);
}

export function checkInteger(name: string, value: unknown): number {
    // Arithmetic on larger numbers is not exact, and the bounds checked later assume it is.
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new TypeError(`${name} must be a safe integer, got ${describe(value)}.`);
    }
    return value;
}

export function describe(value: unknown): string {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
}
