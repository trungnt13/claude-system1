# System1 Thinking

System1 Thinking chooses Claude Code reasoning effort before selected model requests.

- Export `JEV_API_KEY`, then load the plugin.
  - Enabled by default; provider requests may incur charges.
  - Desktop launches do not read `~/.bashrc`.

  ```bash
  claude --plugin-dir ~/codes/claude-system1
  ```

- `/system1` toggles adaptation; arguments are `on`, `off`, or `status`.
  - `off` disables existing subagents too.
  - Native model or effort changes pause adaptation.
  - Accepted effort lasts only within its turn.
  - `/clear` preserves your enabled choice.
- Built-in profiles select fixed decision services.
  - `jev`: TypeSafe System One, `jev-latest`, `JEV_API_KEY`; selected by default.
  - `decision_api`: OpenAI Decision API, `gpt-6-luna`, `DECISION_API_KEY`.
  - Failures never switch providers.
- `profiles` defines named replacements through a JSON string.
  - Required fields: `protocol`, `model`, `api_key_env`.
  - `protocol` accepts `openai` or `typesafe` decision wire formats, not ordinary chat-completions compatibility.
  - Keys must use `SYSTEM1_API_KEY`, `JEV_API_KEY`, or `DECISION_API_KEY` because Claude requires literal names.
  - Optional `endpoint` is the complete HTTPS URL; omission uses the protocol's canonical endpoint.
  - URL credentials, fragments, unknown fields, and unknown profile names are rejected.
- Optional `rubric_instructions` replaces the default rubric.
  - Overrides must be nonblank and at most 4,096 UTF-8 bytes.
  - Keep evidence untrusted and require a supplied choice.
- Configure through user settings or `--settings`, not project settings.
  - Save this example as `system1-options.json`; replace its endpoint and model.
  - Export `SYSTEM1_API_KEY` separately; never store keys in configuration or URLs.

  ```json
  {
    "pluginConfigs": {
      "system1": {
        "options": {
          "enabled": false,
          "profile": "third_party",
          "profiles": "{\"third_party\":{\"protocol\":\"openai\",\"model\":\"provider-model\",\"api_key_env\":\"SYSTEM1_API_KEY\",\"endpoint\":\"https://example.com/v1/decisions\"}}"
        }
      }
    }
  }
  ```

  ```bash
  claude --plugin-dir ~/codes/claude-system1 --settings /absolute/path/to/system1-options.json
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
  - Option changes reload state and apply startup settings.
- Providers receive task, steering, and recent conversation excerpts, including tool-result text.
  - Evidence is not secret-redacted; trust your provider.
  - Replies must contain exactly one supplied choice.
- Failures retain current effort; transient retries use exponential cooldown, capped at 30 seconds.
  - Missing keys and permanent client errors block decisions until re-enabled.
  - Timeouts cannot cancel dispatched requests; retries may overlap and incur charges.
  - No spending cap exists.
  - Redirects may forward evidence even when authorization headers are stripped.
- Validated on Claude Code 2.1.296: strict compilation, plugin validation, and 25 offline checks.
  - Headless runs confirmed effort propagation and cache preservation; recheck after upgrades.
  - Desktop, interactive use, subagents, third-party providers, and real-work decision quality remain unverified.
- Diagnostic scripts send real requests and may expose sensitive text in output.
  - `scripts/drive_turns.py` separates prompts into turns.
  - `scripts/wire_proxy.py` logs metadata and complete system messages while forwarding requests to Anthropic.
  - Keep logs private and outside the repository.
