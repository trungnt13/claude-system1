# Adaptive effort

A Claude Code mod that ports ASM adaptive reasoning. Before selected model steps, a separate classifier picks the main request's reasoning effort. The classifier is a native Claude completion (`$.model.complete`, default `haiku`), so it needs no extra API key or external service.

## Start

```bash
claude --plugin-dir ./claude/mods/adaptive-effort
```

Loading the mod makes no extra requests. Inside Claude, `/autoeffort` toggles adaptation; `/autoeffort on|off|status` sets or reports it. After each accepted decision the status line shows `effort <level> · auto`. `/clear` keeps the on/off choice.

## How it maps to ASM

| ASM behavior | This mod |
|---|---|
| A separate classifier picks the next step's effort, awaited before the request with a deadline | A `turn.step` hook awaits `$.model.complete` with `timeoutMs` (default 2,000 ms) and the step's abort signal |
| Default rubric | Same text, plus one line asking for exactly one choice, because a text completion has no choice schema |
| Choices are the ordered levels within bounds and supported by the model; fewer than two refuses enabling | `low`…`xhigh` within `minEffort`/`maxEffort`; `max` excluded by policy. Steps whose native effort is `max`, numeric or absent are left unchanged, and status reports them inactive |
| Per-turn evidence: the turn's input as task (≤ 1/3 of the budget), input arriving mid-turn as steer, then recent items newest first, within a UTF-8 byte budget | Same layout. Task comes from `turn.start`, or else the newest user message. Steer comes from `prompt.submit` for prompts folded into the running turn. Recent rows come from `$.session.messages()` |
| Cadence: turns 1, 1+N, …; within a turn, M steps between accepted decisions; enabling makes the next step due | Same counters per loop (`turnInterval`, `stepInterval`); failures do not consume spacing |
| An accepted effort applies to the rest of its turn only | Each turn starts at native effort until a decision is accepted |
| A failure keeps the current effort; cooldown 1, 2, 4, 8, 16, 30 s; other 4xx errors block until off→on | Timeout, transport, 408/429, 5xx, and empty or invalid replies are transient. Other 4xx errors and engine refusals block new decisions; the current effort is kept |
| Stale results (toggle, manual change, cancellation) are discarded and not counted as failures | Generation counter plus the step's abort signal |
| An applied manual model or effort change pauses adaptation | While on, a native model or effort that differs from the previous step pauses it (`/model`, `/effort`, settings, or an engine fallback model); enabling takes a fresh baseline |
| Children inherit the parent's enabled flag once, then own their state | `subagents` option, default off because subagent profiles pin their effort deliberately. `/autoeffort off` reaches every loop, since subagents have no toggle of their own |
| Cache-preserving positional effort control | Provided by Claude Code itself; see below |

## Cache behavior (measured)

Claude Code 2.1.296 already implements the Anthropic counterpart of ASM's positional `configuration_update`:
- It sends the `per-turn-control-2026-07-01` beta and pins the opening effort on the first system-role message.
- When a hook changes `effort`, it appends a positional system message with `output_config: {effort}` and updates the top-level value.

In a proxied run (Opus 5.5, medium → high at step 2), the switching request read the whole prior prefix from cache: 98,192 tokens read, 171 written. The independent review reproduced this on Haiku. Changing effort through `turn.step` therefore keeps the conversation cache on this build. Recheck after upgrades.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `controllerModel` | `haiku` | Classifier model alias or id; billed to the session's account |
| `minEffort` / `maxEffort` | `low` / `xhigh` | Choice bounds |
| `turnInterval` | `1` | Decide on loop turns 1, 1+N, 1+2N |
| `stepInterval` | `2` | Steps between accepted decisions in a selected turn |
| `timeoutMs` | `2000` | Decision deadline; on expiry the current effort is kept |
| `evidenceBytes` | `8192` | UTF-8 evidence budget |
| `subagents` | `false` | Subagents copy the main loop's on/off state at their first step |

## Limits

- Module state is in memory. A reload or option change starts with adaptation off.
- A manual change is detected at the next model step, so the status line can lag until then.
- `$.session.messages()` rows do not mark harness rows such as command caveats or reminders. Recent evidence, and the task fallback, may include text ASM would skip.
- The classifier sees bounded excerpts: no thinking blocks, images or full tool inputs.
- Each decision adds the classifier's latency to its step: 0.63–1.61 s with `haiku` across runs, and one decision of eight hit the 2 s default deadline.

## Validation (2026-10-15, Claude Code 2.1.296)

- `claude plugin validate ./claude/mods/adaptive-effort --strict` passes. Strict `tsc` against the build's declarations passes.
- Headless `--plugin-dir` runs, one with a wire-logging proxy:
  - Decisions ran before steps 0, 2 and 4, and the chosen effort reached every main request.
  - The native effort reported to the hook is the session setting, not the rewritten one.
  - Each new turn restarted at native effort.
  - A 2 s timeout kept the current effort and entered cooldown.
  - `/effort high` paused adaptation at the next step, and `/autoeffort on` resumed it.
- Not verified: interactive terminal and desktop use, subagents, blocking errors, and decision quality on real work.
