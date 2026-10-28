# Reference
## decisions
<details><summary><code>client.decisions.<a href="/src/api/resources/decisions/client/Client.ts">create</a>({ ...params }) -> Decisions.DecisionsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Asks questions about one audio file and returns the answers, with the `run_id` of the model run that produced them. Each answer estimates how human raters would respond, so you choose the thresholds for acting on it.

Ask every question you have about the same audio in one request. All the questions are answered in one model inference, so an answer can change when other questions are added, removed or reordered. To compare answers across recordings, send the same questions in the same order. To evaluate several files, send one request per file.

## What the model reads

For each question, the model reads:

1. The question's `instructions`.
2. The question's `criteria`: each `choice` option's `name`, with its `description` when it has one; the text of each `score` level; or a `noul` question's `true` and `false` guidance.
3. The request's `context`.
4. The audio.

Answers are keyed by question ID, `choice` probabilities by option `name`, and `score` probabilities by level index.

## Choosing a primitive

| To ask | Use | The answer gives |
|---|---|---|
| Whether something is true of the audio | `noul` | The share of raters who would answer yes |
| Which of several options applies | `choice` | The probability of each option, and the most likely one |
| Where the audio falls on an ordered scale | `score` | The probability of each level, and the probability-weighted mean level |
| When an event occurs | `moment` | The moments where the event may occur, in milliseconds from the start of the file |

## Using the answers

1. Each probability estimates the share of human raters who would give that answer. A `noul` answer near 0.5 means raters would split on the audio, not that the model is unsure.
2. `confidence` measures how much raters would agree, not how certain the model is.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.decisions.create({
    file: fs.createReadStream("/path/to/your/file"),
    request: {
        context: "A simulated test call in which a voice AI agent helps a caller reschedule an appointment. Both voices are synthetic, and the agent speaks first.",
        questions: {
            "talks_over_caller": {
                type: "noul",
                instructions: "Does the agent talk over the caller?"
            },
            "agent_tone": {
                type: "choice",
                instructions: "Which best describes the tone of the agent?",
                criteria: [{
                        name: "warm",
                        description: "Warm and friendly toward the caller"
                    }, {
                        name: "neutral",
                        description: "Polite but impersonal"
                    }, {
                        name: "curt",
                        description: "Short or dismissive with the caller"
                    }]
            },
            "agent_naturalness": {
                type: "score",
                instructions: "How natural does the agent sound?",
                criteria: ["Not at all", "2", "3", "4", "Extremely"]
            },
            "agent_glitches": {
                type: "moment",
                instructions: "Where does the agent glitch, slur or sound robotic?"
            }
        }
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `Decisions.DecisionsCreateRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `DecisionsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.decisions.<a href="/src/api/resources/decisions/client/Client.ts">inputTokens</a>({ ...params }) -> Decisions.InputTokensResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Counts the input tokens a decisions request would be billed for, without evaluating the audio or recording a run. Send the same body you would send to `POST /v0/decisions/file`.

The request is validated the same way as a decisions request, and fails with the same errors. The response has no `run_id`, because no run is recorded.

Hume counts the input tokens from the audio duration, the context and the questions.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.decisions.inputTokens({
    file: fs.createReadStream("/path/to/your/file"),
    request: {
        context: "A simulated test call in which a voice AI agent helps a caller reschedule an appointment. Both voices are synthetic, and the agent speaks first.",
        questions: {
            "talks_over_caller": {
                type: "noul",
                instructions: "Does the agent talk over the caller?"
            },
            "agent_tone": {
                type: "choice",
                instructions: "Which best describes the tone of the agent?",
                criteria: [{
                        name: "warm",
                        description: "Warm and friendly toward the caller"
                    }, {
                        name: "neutral",
                        description: "Polite but impersonal"
                    }, {
                        name: "curt",
                        description: "Short or dismissive with the caller"
                    }]
            },
            "agent_naturalness": {
                type: "score",
                instructions: "How natural does the agent sound?",
                criteria: ["Not at all", "2", "3", "4", "Extremely"]
            },
            "agent_glitches": {
                type: "moment",
                instructions: "Where does the agent glitch, slur or sound robotic?"
            }
        }
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `Decisions.DecisionsInputTokensRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `DecisionsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## runs
<details><summary><code>client.runs.<a href="/src/api/resources/runs/client/Client.ts">list</a>({ ...params }) -> Decisions.RunsPage</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Your organization's runs, newest first, one page at a time. The filters combine.

A run is one model inference. A successful decisions request is recorded as a run, which can take a moment to appear in this list, and under heavy load may not be recorded. A decisions request that fails before its input reaches the model, including every request rejected with a `4xx` status, has none.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.runs.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `Decisions.ListRunsRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RunsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.runs.<a href="/src/api/resources/runs/client/Client.ts">get</a>({ ...params }) -> Decisions.Run</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

The run's status, when it started and ended, the audio it received, and the request it evaluated. The run does not include the answers.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.runs.get({
    runId: "019a1f3c-7d2e-7b41-9c58-2e6f4a1d8b03"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `Decisions.GetRunsRequest` 
    
</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RunsClient.RequestOptions` 
    
</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

