# System1 Thinking

System1 Thinking chooses Claude Code reasoning effort before selected model requests.

- Export `JEV_API_KEY`, then choose marketplace installation or local loading.
  - Enabled by default; provider requests may incur charges.
  - Desktop launches do not read `~/.bashrc`.
  - Enabled startup schedules one background warmup request, without conversation content.
  - Warmup may incur charges; failures never alter decisions or delay startup.
  - A four-second startup toast reports enabled state and warmup success, failure, or skipped status.
  - An immediate first turn does not wait for warmup completion.

  **Marketplace installation**

  ```bash
  claude plugin marketplace add trungnt13/claude-system1
  claude plugin install system1@tngo-system1 --scope user
  ```

  **Local loading**, from the repository directory; no installation required:

  ```bash
  claude --plugin-dir .
  ```

- `/system1` toggles adaptation; arguments are `on`, `off`, or `status`.
  - `off` disables existing subagents too.
  - Native model or effort changes pause adaptation.
  - Accepted effort lasts only within its turn.
  - The spinner appends `sys1·low`, `sys1·medium`, `sys1·high`, or `sys1·xhigh`.
  - Decision failures append `·err`; the next accepted decision clears it.
  - Without accepted effort, failures show `sys1··err`; cooldowns and new turns preserve errors.
  - Claude’s native effort label remains unchanged; `/system1 status` reports controller failures.
  - `/clear` preserves your enabled choice.
- Built-in profiles select fixed decision services.
  - `jev`: TypeSafe System One, `jev-latest`, `JEV_API_KEY`; selected by default.
  - `decision_api`: OpenAI Decision API, `gpt-6-luna`, `DECISION_API_KEY`.
  - Select one with `profile`; unknown names are rejected.
  - Models, endpoints, and credential names are hard-coded in `hooks/register.ts`.
  - Failures never switch providers.
- Optional `rubric_instructions` replaces selection and safety rules, not choice descriptions.
  - Configure meanings with `lowEffortDescription`, `mediumEffortDescription`, `highEffortDescription`, and `xhighEffortDescription`.
  - Both providers receive descriptions only for allowed choices.
  - Overrides must be nonblank and at most 4,096 UTF-8 bytes.
  - Keep evidence untrusted and require a supplied choice.
- Configure through user settings or `--settings`, not project settings.
  - Save this example as `system1-options.json` to select OpenAI Decision API.
  - Export `DECISION_API_KEY` separately; never store keys in configuration or URLs.

  ```json
  {
    "pluginConfigs": {
      "system1": {
        "options": {
          "enabled": false,
          "profile": "decision_api"
        }
      }
    }
  }
  ```

  ```bash
  claude --plugin-dir . --settings ./system1-options.json
  ```

  - This example starts disabled; inspect `/system1 status`, then authorize requests with `/system1 on`.
  - Installed plugins support `claude plugin configure <name@marketplace> --values-stdin`.
  - Supply a JSON object containing single-line string values; restart afterward.
- Defaults: `minEffort` low, `maxEffort` xhigh, `turnInterval` one, `stepInterval` two.
  - Effort choices require at least two levels between low and xhigh.
  - Native max, numeric, or absent effort remains unchanged.
  - Both intervals accept 1–100; step spacing counts model steps since the last accepted decision.
  - `timeoutMs`: 2,000 milliseconds; allowed range 1–5,000.
  - `evidenceBytes`: 8,192 bytes; allowed range 128–32,768.
  - `subagents`: true; children inherit the main loop's enabled flag once.
  - Hard-coded reviewer limits: `reviewer` uses high–xhigh.
  - Implementer limits: `implementer`, `general-purpose`, `worker`, `claude`, `statusline-setup` use low–high.
  - Role limits intersect global bounds; empty intersections stop matching requests.
  - Role-limited fallbacks stay within bounds; single-choice role ranges skip provider requests.
  - Other or unidentified roles inherit global limits; disabled System1 restores native effort.
  - Option changes reload state and apply startup settings.
- Providers receive task, steering, and recent conversation excerpts, including tool-result text.
  - Evidence is not secret-redacted; trust your provider.
  - Replies must contain exactly one supplied choice.
- Failures retain current effort; transient retries use exponential cooldown, capped at 30 seconds.
  - Missing keys and permanent client errors block decisions until re-enabled.
  - Timeouts cannot cancel dispatched requests; retries may overlap and incur charges.
  - No spending cap exists.
  - Redirects may forward evidence even when authorization headers are stripped.
- Validated on Claude Code 2.1.296: strict compilation, plugin validation, and offline checks.
  - Headless runs confirmed effort propagation and cache preservation; recheck after upgrades.
  - Desktop, interactive use, subagents, and real-work decision quality remain unverified.
