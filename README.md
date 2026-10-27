# Hume Decisions TypeScript SDK

The official TypeScript client for the [Hume Decisions API](https://dev.hume.ai/decisions/docs/overview). The API answers questions about audio that you write in plain language. Send a recording with your questions, and each answer comes back as probabilities that estimate how human raters would respond, which your code can threshold, rank, or combine.

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

Each request takes one audio file, MP3 or WAV, up to 5 minutes long. To evaluate several recordings, send one request per file. The service mixes all channels into one, so to judge one speaker in a call alone, send that speaker's channel as its own file.

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

`decisions.inputTokens` takes the same file and request as `decisions.create` and returns the number of input tokens the request would be billed for, without evaluating the audio or recording a run. Hume counts them from the audio duration, the context, and the questions.

```typescript
const count = await client.decisions.inputTokens({
    file: { path: "test_call.wav", contentType: "audio/wav" },
    request,
});
console.log(count.inputTokens);
```

The request is validated the same way as a decisions request and fails with the same errors.

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

Most of this SDK is generated by [Fern](https://buildwithfern.com) from the API definition, and edits to generated files are overwritten on the next generation. To report a problem, open an issue in this repository.

## License

MIT
