# Hume Audio Decisions TypeScript SDK

The official TypeScript client for the [Hume Audio Decisions API](https://dev.hume.ai/decisions/docs/overview). The API answers questions about audio that you write in plain language. Send a recording with your questions, and each answer comes back as probabilities that estimate how human raters would respond, which your code can threshold, rank, or combine.

The SDK provides clients for the decisions and run endpoints, TypeScript types for every question, answer, and response, and API key authentication. It ships CommonJS and ES module builds.

1. [Documentation](https://dev.hume.ai/decisions/docs/overview)
2. [TypeScript quickstart](https://dev.hume.ai/decisions/docs/quickstart/typescript)
3. [Writing questions](https://dev.hume.ai/decisions/docs/writing-questions)
4. [Primitives](https://dev.hume.ai/decisions/docs/primitives)
5. [Interpreting answers](https://dev.hume.ai/decisions/docs/interpreting-answers)
6. [Runs guide](https://dev.hume.ai/decisions/docs/runs)
7. [Cookbooks](https://dev.hume.ai/decisions/cookbooks/overview)
8. [API reference](https://dev.hume.ai/decisions/reference)

## Requirements

Node.js 18 or later.

## Installation

```bash
npm install @humeai/decisions
```

## Authentication

Every request carries your API key in the `X-Hume-Api-Key` header. Pass the key to the client, or set the `HUME_API_KEY` environment variable and construct the client without arguments.

```typescript
import { DecisionsClient } from "@humeai/decisions";

const client = new DecisionsClient({ apiKey: "YOUR_API_KEY" });
```

Keep API keys on a server. To use the API from a web page, relay through your server. See [Authentication](https://dev.hume.ai/decisions/docs/authentication).

## Preparing audio

Each request takes one MP3 or WAV file up to 5 minutes long. Send one request per recording, and split a longer recording as described in [Long recordings](#long-recordings).

The model hears audio at 16 kHz in one channel: the API resamples every file and mixes its channels into one before the model processes it. To make uploads smaller, the SDK does the same to a WAV file before sending it, in `create` and in the chunked methods. Resampled audio is written as 32-bit floating point, the format the API converts every file to, so loud audio is not clipped. `downmixStrategy` sets how:

1. `"mix"`, the default, resamples audio above 16 kHz to 16 kHz and mixes two channels into one the way the API does, so the model hears the same audio apart from rounding. A file that this would not make smaller, such as 16-bit mono at 16 kHz, is sent as it is, and so is a file with more than two channels, or with two channels its header places anywhere but front left and front right, because the API weighs those channels by the speaker positions the header declares.
2. `"first_channel"` keeps only the first channel of a file with more than one. The channel is copied exactly in the file's own sample format when that is no larger than resampling it, as it is at 16 kHz or below for every sample format but 64-bit floating point, and is otherwise converted the same way as by `"mix"`. Use it to judge one speaker of a call who is on the first channel; for any other channel, send that channel as its own file.
3. `"none"` sends the file as it is.

MP3 files and WAV files the SDK cannot read, such as compressed WAV, are always sent as they are. Unless `downmixStrategy` is `"none"`, `create` reads the whole file into memory before sending it.

## Quickstart

This request asks two questions about a simulated call with a voice AI agent: whether the agent talks over the caller, and how natural the agent sounds on a five-point scale.

```typescript
import { DecisionsClient } from "@humeai/decisions";

const client = new DecisionsClient();

const response = await client.decisions.create({
    file: { path: "test_call.wav", contentType: "audio/wav" },
    request: {
        context: "A simulated test call in which a voice AI agent helps a caller reschedule an appointment. Both voices are synthetic, and the agent speaks first.",
        questions: {
            talks_over_caller: {
                type: "noul",
                instructions: "Does the agent talk over the caller?",
            },
            agent_naturalness: {
                type: "score",
                instructions: "How natural does the agent sound?",
                criteria: ["Not at all", "2", "3", "4", "Extremely"],
            },
        },
    },
});

for (const [questionId, answer] of Object.entries(response.answers)) {
    switch (answer.type) {
        case "noul":
            console.log(`${questionId}: ${Math.round(answer.noul * 100)}% of raters would answer yes`);
            break;
        case "score": {
            const [mostLikely] = Object.entries(answer.probabilities).reduce((top, level) => (level[1] > top[1] ? level : top));
            console.log(`${questionId}: mean level ${answer.score.toFixed(2)}, most often "${answer.legend[mostLikely]}"`);
            break;
        }
    }
}
```

`contentType` labels the file part; for an MP3 file, pass `audio/mpeg`. The response returns each answer under the ID you gave its question, with the `runId` of the model run that produced the answers. A probability estimates the share of human raters who would give that answer, so a `noul` near 0.5 means raters would split on the audio, not that the model is unsure. `score` is the mean level, counted from 0, and `legend` maps each level index back to the text you gave it. The [TypeScript quickstart](https://dev.hume.ai/decisions/docs/quickstart/typescript) walks through the request and the response.

## Questions

Each question is keyed by an ID you choose, and its `type` names its primitive, which sets the `criteria` it takes and the form of its answer. One request can mix primitives.

| Primitive | Asks | `criteria` |
|---|---|---|
| `noul` | Whether something is true of the audio. | Optional. What counts as `true` and as `false`. |
| `choice` | Which of several options applies. | Two or more options, each with a unique `name` and an optional `description`. |
| `score` | Where the audio falls on an ordered scale. | Two or more levels, from lowest to highest. |
| `span` | When an event occurs. | None. |

Request and response types are exported under the `Decisions` namespace.

```typescript
import type { Decisions } from "@humeai/decisions";

const request: Decisions.DecisionsRequest = {
    context: "A simulated test call in which a voice AI agent helps a caller reschedule an appointment. Both voices are synthetic, and the agent speaks first.",
    questions: {
        talks_over_caller: {
            type: "noul",
            instructions: "Does the agent talk over the caller?",
        },
        interruptions: {
            type: "span",
            instructions: "When does the agent interrupt the caller?",
        },
        agent_naturalness: {
            type: "score",
            instructions: "How natural does the agent sound?",
            criteria: ["Not at all", "2", "3", "4", "Extremely"],
        },
        agent_tone: {
            type: "choice",
            instructions: "Which best describes the tone of the agent?",
            criteria: [
                { name: "warm", description: "Warm and friendly toward the caller" },
                { name: "neutral", description: "Polite but impersonal" },
                { name: "curt", description: "Short or dismissive with the caller" },
            ],
        },
    },
};
```

All the questions in a request are answered in one model inference, so an answer can change when other questions are added, removed, or reordered. Ask every question about a recording in one request, and to compare answers across recordings, send the same questions in the same order. [Writing questions](https://dev.hume.ai/decisions/docs/writing-questions) covers how to word instructions and criteria.

## Reading answers

`response.answers` maps each question ID to an answer whose `type` matches the question's primitive, and checking `type` in a `switch` narrows the answer to that primitive's fields.

| `type` | Fields |
|---|---|
| `noul` | `noul`, the share of raters who would answer yes. |
| `choice` | `choice`, the option most raters would choose; `probabilities`, keyed by option name; and `confidence`. |
| `score` | `score`, the mean level; `probabilities` and `legend`, keyed by level index as a string; and `confidence`. |
| `span` | `spans`, each with `audioStartMs`, `audioEndMs`, and `probability`. An empty list means the event was not found. |

```typescript
for (const [questionId, answer] of Object.entries(response.answers)) {
    switch (answer.type) {
        case "noul":
            console.log(`${questionId}: ${answer.noul.toFixed(2)}`);
            break;
        case "choice":
            console.log(`${questionId}: ${answer.choice}, confidence ${answer.confidence.toFixed(2)}`);
            break;
        case "score":
            console.log(`${questionId}: ${answer.score.toFixed(2)} of ${Object.keys(answer.legend).length - 1}, confidence ${answer.confidence.toFixed(2)}`);
            break;
        case "span":
            for (const span of answer.spans) {
                console.log(`${questionId}: ${span.audioStartMs} to ${span.audioEndMs} ms, ${span.probability.toFixed(2)}`);
            }
            break;
    }
}
```

`confidence` measures how much raters would agree, not how certain the model is. A `span` answer gives times but no share of raters, so to ask whether an event occurs as well as when, add a `noul` question. [Primitives](https://dev.hume.ai/decisions/docs/primitives) defines every field, and [Interpreting answers](https://dev.hume.ai/decisions/docs/interpreting-answers) covers setting thresholds for acting on them.

## Counting input tokens

`decisions.inputTokens` counts the input tokens a decisions request would be billed for, from its context, its questions, and the duration of its audio. It takes no audio file, so you can count a request before sending it.

```typescript
const count = await client.decisions.inputTokens({
    audioDurationMs: 135_000,
    context: request.context,
    questions: request.questions,
});
console.log(`${count.inputTokens} input tokens`);
```

`audioDurationMs` is the duration of the file the request would send. A duration over 5 minutes is rejected with `audio_too_long`, so count a long recording one chunk at a time; each chunk is billed as its own request.

## Long recordings

`decisions.createChunked` cuts a recording into chunks no longer than `maxChunkMs` and sends each chunk in its own `create` request, one at a time and in order, with the same questions, context, and request options. The model hears only the chunk it answers about, and each chunk gets its own response, `runId`, and bill. Nothing combines the answers across chunks.

```typescript
import { DecisionsClient } from "@humeai/decisions";

const client = new DecisionsClient();

const result = await client.decisions.createChunked({
    file: { path: "long_call.wav", contentType: "audio/wav" },
    request: {
        context: "A call in which a voice AI agent helps a caller reschedule an appointment.",
        questions: {
            agent_glitches: {
                type: "moment",
                instructions: "Where does the agent glitch, slur or sound robotic?",
            },
            talks_over_caller: {
                type: "noul",
                instructions: "Does the agent talk over the caller?",
            },
        },
    },
    maxChunkMs: 300_000,
});

for (const chunk of result.chunks) {
    if (chunk.status !== "succeeded") {
        console.log(`chunk ${chunk.index} (${chunk.startMs} to ${chunk.endMs} ms): ${chunk.status}, ${chunk.error}`);
        continue;
    }
    const answer = chunk.response.answers.agent_glitches;
    if (answer.type === "moment") {
        for (const moment of answer.moments) {
            // Moments are measured from the start of the chunk.
            console.log(`${chunk.startMs + moment.audioStartMs} to ${chunk.startMs + moment.audioEndMs} ms`);
        }
    }
}
```

Each chunk's `startMs` and `endMs` give where it starts and ends in the recording, so add its `startMs` to a moment's times to place the moment in the recording. Pass `startMs` and `endMs` to `createChunked` to send only part of the recording.

### Chunk length

`maxChunkMs` has no default, because it decides how many requests the job sends, and each request is billed for its own audio, context, and questions.

1. Use 300000, the longest chunk the API accepts, for the fewest requests.
2. Use shorter chunks for answers about shorter stretches of the call. A `noul` or `score` answer describes its whole chunk, so with 60000 ms chunks each answer covers at most one minute.

By default, the recording is cut into the fewest chunks that fit, of equal length, so the last chunk is not a short remainder: a 32-minute call at 300000 ms becomes 7 chunks of about 4 minutes 34 seconds, not 6 of 5 minutes and 1 of 2 minutes. Pass `split: "fixed"` when chunks must be the same length in every recording, for example to count per 5 minutes across calls. Every chunk is then `maxChunkMs` long except the last, which holds what remains and is billed like any other.

A WAV recording takes its duration divided by `maxChunkMs` requests, rounded up: a 32-minute call takes 7 at 300000 ms and 32 at 60000 ms. Each chunk must also fit the API's limit of 25,000,000 bytes per request. With the default `downmixStrategy`, 5 minutes of mono or stereo WAV always fits. A file that does not fit is cut into shorter chunks that do, so 16-bit stereo sent with `downmixStrategy: "none"` is cut into chunks of at most 136054 ms at 44.1 kHz and 124999 ms at 48 kHz. With `split: "fixed"`, `createChunked` instead rejects with a `RangeError` naming the largest `maxChunkMs` that fits, before it sends anything.

An MP3 recording can take more requests, because each chunk repeats a little audio from the chunk before, as described under [Where cuts fall](#where-cuts-fall). At 300000 ms this adds at most one request for recordings shorter than several hours, and only when the recording is at or just under a multiple of 5 minutes. Shorter chunks lose a larger share to repeated audio, so they can add several.

### Writing questions for chunks

The model answers about each chunk as if it were the whole recording, so write the context and questions to hold for any part of the call:

1. Describe in the context what is true throughout the call, such as who is speaking and what the call is for. A detail about one part of the call, such as "the agent speaks first", is true of the first chunk only, and in every other chunk it describes audio the model cannot hear.
2. Ask about what can be heard within a single chunk. "Does the agent talk over the caller?" can be answered from any stretch of the call. "Is the caller's appointment rescheduled by the end of the call?" cannot, because the end of the call is in only one chunk.

### Combining answers

The answers are not combined for you, because the right way to combine them depends on the question. To ask whether something happens anywhere in the call, take the highest `noul` across the chunks:

```typescript
if (result.complete) {
    const nouls = result.responses.flatMap((response) => {
        const answer = response?.answers.talks_over_caller;
        return answer?.type === "noul" ? [answer.noul] : [];
    });
    const highest = Math.max(...nouls);
    console.log(`In the chunk most likely to show it, ${Math.round(highest * 100)}% of raters would say the agent talks over the caller.`);
}
```

To ask how much of the call something describes, count the chunks whose `noul` passes a threshold instead. A `moment` answer needs no combining once its times are placed in the recording.

### Where cuts fall

1. A WAV file is cut between samples, after it is mixed down.
2. An MP3 file is cut between frames, without being decoded, so chunks can differ in length by a frame or more; a frame lasts 24 to 72 ms. A frame can depend on the frames before it, so every chunk after the first starts with frames repeated from the end of the chunk before, usually a fraction of a second and up to about 2 seconds at the lowest bitrates. They count toward `maxChunkMs` and are included in the chunk's `startMs`, so a moment near a cut can appear in both chunks. Most MP3 files also start with a few tens of milliseconds of silence that the encoder added and players skip. Times are measured from where a player starts the file, so the first chunk's `startMs` can be below 0.

In both formats, an event that crosses a cut, such as the agent talking over the caller for a second or two around it, is heard in part by each chunk. A `moment` question can return it as two shorter moments, as one that ends or starts at the cut, or not at all, and a `noul` answer about it can come out lower in both chunks than for audio that holds the whole event. The frames an MP3 chunk repeats are there so it can be decoded, and cannot be relied on to cover an event at a cut.

### Failures and resuming

A request the API rejects, or whose connection fails, does not reject. Its error is recorded on the chunk, and `createChunked` resolves with the responses it received, so check `result.complete` before relying on the result.

1. A chunk whose audio cannot be decoded (`audio_decode_failed`) fails on its own, and the remaining chunks are still sent, as long as an earlier chunk succeeded. Until one has, the whole file is the likely cause, so the job stops.
2. Any other error stops the job, such as running out of tokens (402), an invalid request, or a dropped connection. The chunks after it have the status `"not_attempted"`: no request was sent for them, so they were not billed.
3. Rate limits and server errors are retried first, as for any request, so they stop the job only once the retries run out. Pass `maxRetries` in the request options to allow more.
4. Aborting the `abortSignal` in the request options is not recorded on a chunk. `createChunked` rejects with the same `DecisionsError` as an aborted `create`, no further chunk is sent, and the responses already received are lost, so use `iterCreateChunked` to keep them.

To resume a job that stopped, call `createChunked` again with `startMs: result.resumeMs` and the same `endMs`. `resumeMs` is where the chunk before the one that stopped the job ends, or undefined when no chunk stopped the job. The new job sends the audio of the chunk that stopped the job and everything after it, in no more chunks than the stopped job had left. It does not resend earlier chunks that failed because their audio could not be decoded, so its `complete` covers only the range it sent. With the default `split: "even"`, its cuts after the first chunk can fall a few MP3 frames or a millisecond of WAV from the stopped job's. A WAV chunk's `startMs` is rounded to the millisecond, so the resumed job can skip or repeat a few samples where it starts.

### Memory

The whole recording is read into memory, and a WAV file is mixed down, before the first request, so a file that cannot be split is rejected before anything is billed, with an `UnsupportedAudioError` from `@humeai/decisions/audio-helpers` when it is empty or not a supported MP3 or WAV file. An hour of 16-bit stereo WAV at 48 kHz is about 690 MB, plus about 230 MB for the mixed-down copy.

### Saving results as they arrive

`createChunked` resolves only once every chunk is done, so if your process stops partway through a long job, the responses it received are lost, although they were billed. `decisions.iterCreateChunked` cuts and sends the chunks the same way, but yields each chunk's result as soon as its request is done, so you can save each response before the next chunk is sent:

```typescript
import { writeFile } from "node:fs/promises";
import { DecisionsClient } from "@humeai/decisions";

const client = new DecisionsClient();

for await (const chunk of client.decisions.iterCreateChunked({
    file: { path: "long_call.wav", contentType: "audio/wav" },
    request: {
        questions: {
            agent_glitches: {
                type: "moment",
                instructions: "Where does the agent glitch, slur or sound robotic?",
            },
        },
    },
    maxChunkMs: 300_000,
})) {
    if (chunk.status === "succeeded") {
        await writeFile(`chunk_${chunk.index}_${chunk.startMs}.json`, JSON.stringify(chunk.response));
    }
}
```

`iterCreateChunked` checks its options when it is called, but reads the recording only when iteration starts, so a stream passed as `file` must stay open until then.

To resume such a job, keep the results it yields.

1. When a chunk stopped the job, `new ChunkedDecisionsResult(results, startMs).resumeMs` gives where to resume, with `ChunkedDecisionsResult` from `@humeai/decisions/audio-helpers` and the `startMs` the job was given.
2. When your process stopped instead, `resumeMs` is undefined. Resume at the `endMs` of the last chunk you have a result for, not at the `startMs` of the chunk after it, which for an MP3 file includes frames repeated from the chunk you already have.

In both cases, pass the same `endMs` as the job that stopped. Chunks that failed because their audio could not be decoded are not sent again, including the last chunk you have a result for, so check your saved results for them.

### Sending chunks yourself

`iterAudioChunks` in `@humeai/decisions/audio-helpers` cuts a recording the same way, mixdown included, and yields each chunk's bytes with its `startMs` and `endMs`. Use it to send chunks some other way, such as several at a time:

```typescript
import { type Decisions, DecisionsClient } from "@humeai/decisions";
import { type AudioChunk, iterAudioChunks } from "@humeai/decisions/audio-helpers";

const client = new DecisionsClient();

const chunks: AudioChunk[] = [];
for await (const chunk of iterAudioChunks({ path: "long_call.wav" }, { maxChunkMs: 300_000 })) {
    chunks.push(chunk);
}

const results: PromiseSettledResult<Decisions.DecisionsResponse>[] = [];
for (let first = 0; first < chunks.length; first += 4) {
    const batch = chunks.slice(first, first + 4).map((chunk) =>
        client.decisions.create({
            file: { data: chunk.data, filename: "chunk.wav", contentType: "audio/wav" },
            request,
            // The chunk is already mixed down, so it is sent as it is.
            downmixStrategy: "none",
        }),
    );
    results.push(...(await Promise.allSettled(batch)));
}
for (const chunk of chunks) {
    console.log(chunk.index, chunk.startMs, results[chunk.index]);
}
```

Sending several chunks at once reaches rate limits sooner, and a failure does not stop the requests already in flight, which are still billed. `createChunked` sends one chunk at a time for these reasons.

### In a browser

The audio helpers import no Node.js modules, so `iterAudioChunks` can also cut a recording in a web page, for example before uploading each chunk to your server, which sends it to the API with your key. Pass the recording as a `File` or `Blob`, such as one from a file input; `{ path }` reads from the file system, which browsers do not offer. The mixdown runs on the page's main thread and pauses regularly to let the page handle other events. The recording and its mixed-down copy are both held in the page's memory, as described under [Memory](#memory).

## Runs

Every successful decisions request is recorded as a run, identified by the `runId` of its response. The run endpoints return a run's status, when it started and ended, and the request it evaluated. They do not return answers, so keep the answers you need from the response.

```typescript
import { DecisionsClient } from "@humeai/decisions";

const client = new DecisionsClient();

const page = await client.runs.list({ status: "ended", pageSize: 20 });
for (const summary of page.runs) {
    console.log(summary.runId, summary.status, summary.startedAt.toISOString());
}

const run = await client.runs.get({ runId: "019a1f3c-7d2e-7b41-9c58-2e6f4a1d8b03" });
console.log(run.status, Object.keys(run.request.questions));
```

`runs.list` returns your organization's runs, newest first, one page at a time, and filters by `userId`, `status`, `startedAfter`, and `startedBefore`. Pass a page's `nextCursor` back as `cursor`, with the same filters, to fetch the next one; the last page has none. The [runs guide](https://dev.hume.ai/decisions/docs/runs) covers run status and the filters.

## Errors

The client methods reject with a `DecisionsError` when a request fails. `statusCode` holds the HTTP status, and `body` holds the error body, whose `code` says what went wrong and whose `param` points to the field it concerns, when there is one. A `401` body has no `code`; it carries a `message` and, when an API key was rejected, a `requestId`.

```typescript
import { DecisionsError } from "@humeai/decisions";

try {
    await client.decisions.create({ file: { path: "test_call.wav", contentType: "audio/wav" }, request });
} catch (error) {
    if (!(error instanceof DecisionsError)) throw error;
    console.error(`${error.statusCode}: ${JSON.stringify(error.body)}`);
}
```

The client retries a request that fails with a 408, 429, or 5xx status up to 2 times, waiting as long as the response's `Retry-After` header asks when it has one. Pass `maxRetries` to the client, or in the request options for one request, to change the limit. Requests time out after 60 seconds unless you pass a different `timeoutInSeconds` the same way.

[Errors](https://dev.hume.ai/decisions/docs/errors) lists every code and whether to retry.

## Contributing

Most of this SDK is generated by [Fern](https://buildwithfern.com) from the API definition, and edits to generated files are overwritten on the next generation. [CONTRIBUTING.md](https://github.com/HumeAI/hume-decisions-typescript-sdk/blob/main/CONTRIBUTING.md) explains how to build and test the project and how to add code that persists across regenerations. To report a problem, open an issue in this repository.

## License

MIT
