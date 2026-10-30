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

Asks questions about one audio file and returns an answer to each, with the `run_id` of the model run that produced them. Each answer estimates how human raters would respond, so you choose the thresholds for acting on it.

All the questions in a request are answered in one model inference, so an answer can change when other questions are added, removed or reordered. To compare answers across recordings, send the same questions in the same order. To evaluate several files, send one request per file.
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

**request:** `Decisions.DecisionsUpload` 
    
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

Counts the input tokens a decisions request would be billed for, without uploading or evaluating its audio. Send the `request` part of the decisions request as a JSON body, with `audio_duration_ms` for the audio file it would send. No run is recorded, so the response has no `run_id`.

The context and questions are validated as a decisions request's are, and fail with the same errors. The audio itself is not checked, so a request counted here can still be rejected by `POST /v0/decisions/file` for its audio file.

Hume counts input tokens from the audio duration, the context, and each question's text, options and type.
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
    audioDurationMs: 1,
    questions: {
        "whispered": {
            type: "noul",
            instructions: "Is the voice whispering?"
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

**request:** `Decisions.InputTokensRequest` 
    
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

