// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type * as Decisions from "../src/api/index";
import { DecisionsClient } from "../src/Client";
import { DecisionsError } from "../src/errors/index";
import { rejection, samplesWav } from "./audio-helpers/audioFiles";

interface Answer {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: string;
}

interface FakeApi {
    readonly url: string;
    readonly paths: string[];
    answer: (request: IncomingMessage) => Answer;
    readonly close: () => Promise<void>;
}

// A real server, so that the runtime's own fetch decides whether a redirect is followed.
async function startApi(): Promise<FakeApi> {
    const server: Server = createServer((request, response) => {
        api.paths.push(request.url ?? "");
        request.resume();
        request.on("end", () => {
            const { status, headers, body } = api.answer(request);
            response.writeHead(status, headers);
            response.end(body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const api: FakeApi = {
        url: `http://127.0.0.1:${port}`,
        paths: [],
        answer: () => ({ status: 200, body: "{}" }),
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
    return api;
}

const REQUEST: Decisions.DecisionsRequest = {
    questions: { talks_over_caller: { type: "noul", instructions: "Does the agent talk over the caller?" } },
};

const CALLS: readonly [string, (client: DecisionsClient) => Promise<unknown>][] = [
    [
        "decisions.create",
        (client) =>
            client.decisions.create({
                request: REQUEST,
                file: samplesWav([0, 0, 0, 0], { channels: 1, sampleRate: 16000 }),
            }),
    ],
    ["decisions.inputTokens", (client) => client.decisions.inputTokens({ ...REQUEST, audioDurationMs: 6000 })],
    ["runs.list", (client) => client.runs.list()],
    ["runs.get", (client) => client.runs.get({ runId: "019a1f3c-7d2e-7b41-9c58-2e6f4a1d8b03" })],
];

async function decisionsError(call: Promise<unknown>): Promise<DecisionsError> {
    const error = await rejection(call);
    expect(error).toBeInstanceOf(DecisionsError);
    return error as DecisionsError;
}

let api: FakeApi;
let elsewhere: FakeApi;
let client: DecisionsClient;

beforeEach(async () => {
    api = await startApi();
    elsewhere = await startApi();
    client = new DecisionsClient({ apiKey: "test", baseUrl: api.url, maxRetries: 0 });
});

afterEach(async () => {
    await api.close();
    await elsewhere.close();
});

it("client.fetch resolves with a redirect's response rather than following it", async () => {
    api.answer = () => ({ status: 307, headers: { location: `${elsewhere.url}/v0/decisions/runs` } });

    const response = await client.fetch("/v0/decisions/runs");

    expect(response.status).toBe(307);
    expect(api.paths).toHaveLength(1);
    expect(elsewhere.paths).toEqual([]);
});

describe.each(CALLS)("%s", (_name, call) => {
    it("does not follow a redirect, so the API key and the request body go nowhere else", async () => {
        // A JSON object body, so that only the status can make the redirect fail.
        api.answer = (request) => ({
            status: 307,
            headers: { location: `${elsewhere.url}${request.url}`, "content-type": "application/json" },
            body: "{}",
        });

        const error = await decisionsError(call(client));

        expect(error.statusCode).toBe(307);
        expect(error.rawResponse?.headers.get("location")).toBe(`${elsewhere.url}${api.paths[0]}`);
        expect(api.paths).toHaveLength(1);
        expect(elsewhere.paths).toEqual([]);
    });

    it.each<[string, Answer]>([
        ["a plain-text 500", { status: 500, headers: { "content-type": "text/plain" }, body: "Internal Server Error" }],
        ["a 502 page without a content type", { status: 502, body: "<html>Bad gateway</html>" }],
        [
            "a 400 labelled as JSON that is not JSON",
            { status: 400, headers: { "content-type": "application/json" }, body: "<html>oops</html>" },
        ],
        ["an empty 401", { status: 401, headers: { "content-type": "application/json" }, body: "" }],
        [
            "a 429 whose body is a JSON array",
            { status: 429, headers: { "content-type": "application/json" }, body: "[]" },
        ],
        ["a 200 whose body is null", { status: 200, headers: { "content-type": "application/json" }, body: "null" }],
        [
            "a 200 whose body is a JSON array",
            { status: 200, headers: { "content-type": "application/json" }, body: "[1, 2]" },
        ],
        ["a 200 page without a content type", { status: 200, body: "<html>Welcome to the network</html>" }],
        [
            "a 200 page labelled as HTML",
            { status: 200, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" },
        ],
        ["an empty 200", { status: 200, headers: { "content-type": "application/json" }, body: "" }],
    ])("rejects %s with its status and raw body", async (_description, answer) => {
        api.answer = () => answer;

        const error = await decisionsError(call(client));

        expect(error.statusCode).toBe(answer.status);
        expect(error.body).toBe(answer.body);
    });
});
