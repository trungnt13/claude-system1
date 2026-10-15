# System1 Thinking

System1 Thinking is a Claude Code mod that ports ASM adaptive reasoning. Before selected model steps, a decision service picks the main request's reasoning effort. The decision service is TypeSafe Jev or the OpenAI Decision API, using ASM's wire formats. No language model is used as the classifier, and there is no fallback provider.

## Start

```bash
claude --plugin-dir ~/codes/claude-system1
```

Export the selected profile's key in the environment that starts Claude. A Claude launched from the desktop app does not read `~/.bashrc`. There, a missing key blocks adaptation, and the status line shows `System1 Thinking blocked: … JEV_API_KEY is missing or empty`. System1 Thinking is on at start, matching ASM's `enabled = true`; turn this off with the `enabled` option. `/system1` toggles System1 Thinking; `/system1 on|off|status` sets or reports it. After each accepted decision the status line shows `System1 Thinking · <level>`. `/clear` keeps the on/off choice.

| Profile | Endpoint | Model | Key variable | Wire format |
|---|---|---|---|---|
| `jev` (default) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `JEV_API_KEY` | `{model, state, questions: {reasoning_effort: {type: "choice", instructions, criteria}}}` → `{answers: {reasoning_effort: {type: "choice", choice}}}` |
| `decision_api` | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | `DECISION_API_KEY` | `{model, input: [...], questions: [{type: "choice", name: "reasoning_effort", instructions, choices}]}` → `{answers: [{name, type: "choice", choice}]}` |

Every decision is a paid request, and bounded conversation excerpts leave Claude for the selected service.

## How it maps to ASM

| ASM behavior | This mod |
|---|---|
| A decision service picks the next step's effort, awaited before the request with a deadline | A `turn.step` hook awaits the decision, racing a local `timeoutMs` deadline (default 2,000 ms) and the step's abort signal |
| Rubric sent as the choice question's instructions; input in ≤ 8 KiB items, cut at line breaks; reply ≤ 16 KiB with exactly one supplied choice | Same rubric, item split, reply limit and strict answer check |
| Choices are the ordered levels within bounds and supported by the model; fewer than two refuses enabling | `low`…`xhigh` within `minEffort`/`maxEffort`; `max` excluded by policy. Steps whose native effort is `max`, numeric or absent are left unchanged, and status reports them inactive |
| Per-turn evidence: the turn's input as task (≤ 1/3 of the budget), input arriving mid-turn as steer, then recent items newest first, within a UTF-8 byte budget | Same layout. Task comes from `turn.start`, or else the newest user message. Steer comes from `prompt.submit` for prompts folded into the running turn. Recent rows come from `$.session.messages()` |
| Cadence: turns 1, 1+N, …; within a turn, M steps between accepted decisions; enabling makes the next step due | Same counters per loop (`turnInterval`, `stepInterval`); failures do not consume spacing |
| An accepted effort applies to the rest of its turn only | Each turn starts at native effort until a decision is accepted |
| A failure keeps the current effort; cooldown 1, 2, 4, 8, 16, 30 s. Missing credentials and other 4xx errors block until off→on | Same. Timeout, transport errors, 408/429, 5xx, oversized replies and invalid answers are transient |
| The probe is released at its deadline; stale results (toggle, manual change, cancellation) are discarded and not counted as failures | The wait ends at the deadline and the next due step after cooldown asks again; a generation counter and the step's abort signal discard stale results |
| An applied manual model or effort change pauses adaptation | While on, a native model or effort that differs from the previous step pauses it (`/model`, `/effort`, settings, or an engine fallback model). Enabling takes a fresh baseline |
| Children inherit the parent's enabled flag once, then own their state | `subagents` option, default off because subagent profiles pin their effort deliberately. `/system1 off` reaches every loop, since subagents have no toggle of their own |
| Cache-preserving positional effort control | Provided by Claude Code itself; see below |

## Cache behavior (measured)

Claude Code 2.1.296 already implements the Anthropic counterpart of ASM's positional `configuration_update`:
- It sends the `per-turn-control-2026-07-01` beta and pins the opening effort on the first system-role message.
- When a hook changes `effort`, it appends a positional system message with `output_config: {effort}` and updates the top-level value.

In a proxied run (Opus 5.5, medium → high at step 2), the switching request read the whole prior prefix from cache: 98,192 tokens read, 171 written. Changing effort through `turn.step` therefore keeps the conversation cache on this build. Recheck after upgrades.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `profile` | `jev` | Decision service profile (table above) |
| `enabled` | `true` | Start each session with System1 Thinking on |
| `minEffort` / `maxEffort` | `low` / `xhigh` | Choice bounds |
| `turnInterval` | `1` | Decide on loop turns 1, 1+N, 1+2N |
| `stepInterval` | `2` | Steps between accepted decisions in a selected turn |
| `timeoutMs` | `2000` | Decision deadline, 1–5,000 ms; on expiry the current effort is kept |
| `evidenceBytes` | `8192` | UTF-8 evidence budget, 128–32,768 bytes |
| `subagents` | `false` | Subagents copy the main loop's on/off state at their first step |

## Differences from ASM

- **No real cancellation:** the host's `$.http.fetch` takes no abort signal, timeout or redirect setting. The deadline stops the wait but cannot cancel a request already sent. Such a request still runs to completion and is billed; its late answer is discarded. The host follows redirects, where ASM disables them. It drops `Authorization` on a cross-origin redirect but re-sends the body.
- **No custom setup:** no custom endpoints, rubric override or startup warmup request. Without warmup, the first `decision_api` decision is slower (1,784 ms measured against the 2,000 ms default).
- **State is in memory:** a reload or option change re-reads `enabled` and resets counters.
- **Manual changes are noticed late:** detection happens at the next model step, so the status line can lag until then.
- **Evidence can include harness rows:** `$.session.messages()` rows do not mark command caveats or reminders, so recent evidence and the task fallback may include text ASM would skip.
- **Bounded excerpts only:** no thinking blocks, images or full tool inputs are sent.

## Validation (2026-10-15, Claude Code 2.1.296)

- `claude plugin validate . --strict` passes. Strict `tsc` against the build's declarations passes.
- Live headless multi-turn runs (Opus 5.5 main model):
  - `jev`: on at start; answers in 223–406 ms; chose `low` for file reads and `high` for a memory-ordering question.
  - `decision_api`: answers in 410–1,784 ms; chose `low` throughout, including for a short proof.
- Verified live: cadence, per-turn reset, the manual-change pause and the missing-key block. The chosen effort was confirmed on the wire. The deadline race was checked against a local stub that held a request for 7 s: the step timed out at 2 s and the late answer was discarded.
- Not verified: interactive terminal and desktop use, subagents, error paths against the real services, and decision quality on real work.

## Test scripts

The validation runs used two standard-library Python scripts. They send real, billed requests to Anthropic and, while adaptation is on, to the decision service.

- [`scripts/drive_turns.py`](scripts/drive_turns.py) runs a multi-turn headless session. It sends each stream-json message only after the previous `result`, so prompts are not folded into one turn.
- [`scripts/wire_proxy.py`](scripts/wire_proxy.py) is a local pass-through proxy to `api.anthropic.com`. It logs each request's model, beta header, `output_config` and system-role effort messages, never credentials.

```bash
python3 -I scripts/wire_proxy.py 18765 /tmp/wire.log
```

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:18765 python3 -I scripts/drive_turns.py claude -p --model claude-opus-5-5 --plugin-dir . --input-format stream-json --output-format stream-json --verbose '["/system1 status", "Read README.md and summarize it in one line.", "/system1 status"]'
```
