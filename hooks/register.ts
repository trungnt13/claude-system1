import type { EngineInterface, Register, SessionMessage } from 'claude-code';

type Effort = 'low' | 'medium' | 'high' | 'xhigh';
type NativeEffort = Effort | 'max' | number | undefined;
type EffortDescriptions = Readonly<Record<Effort, string>>;

// Exclude max by policy.
const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];
const MAIN_LOOP = 'main';
const ROLE_EFFORT_LIMITS = new Map<string, readonly [Effort, Effort]>([
  ['reviewer', ['high', 'xhigh']],
  ['implementer', ['low', 'high']],
  ['general-purpose', ['low', 'high']],
  ['worker', ['low', 'high']],
  ['claude', ['low', 'high']],
  ['statusline-setup', ['low', 'high']],
]);
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

type LoopState = {
  isEnabled: boolean;
  generation: number;
  effort?: Effort;
  role?: string;
  choices: readonly Effort[];
  nativeModel?: string;
  nativeEffort?: NativeEffort;
  turnId: string;
  turnCount: number;
  isTurnSelected: boolean;
  acceptedStep?: number;
  isDecisionDue: boolean;
  task: string;
  steer: string;
  failureCount: number;
  retryAt: number;
  blockReason?: string;
  decisionCount: number;
  outcome: string;
};


const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  let end = Math.min(bytes.length, Math.max(0, Math.floor(maxBytes)));
  // Avoid splitting UTF-8 code points.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function collectEvidence(loop: LoopState, rows: readonly SessionMessage[], limit: number): string {
  let evidence = truncateUtf8(`Current user task:\n${loop.task}`, limit);
  if (loop.steer !== '') evidence += truncateUtf8(`\nLatest user steer:\n${loop.steer}`, (limit * 2) / 3 - encoder.encode(evidence).length);
  evidence += truncateUtf8('\nRecent evidence (newest first):\n', limit - encoder.encode(evidence).length);
  for (const row of [...rows].reverse()) {
    const parts = row.toolResults?.length ? row.toolResults.map(result => `\ntool: ${result.text}`) : row.text === '' ? [] : [`\n${row.role}: ${row.text}`];
    for (const part of parts) {
      const remaining = limit - encoder.encode(evidence).length;
      if (remaining <= 0) return evidence;
      evidence += truncateUtf8(part, remaining);
    }
  }
  return evidence;
}

function isAdaptableEffort(effort: NativeEffort): effort is Effort {
  return typeof effort === 'string' && effort !== 'max';
}


type ApiKeyEnv = 'JEV_API_KEY' | 'DECISION_API_KEY';
type DecisionProfile = { name: string; protocol: 'typesafe' | 'openai'; url: string; model: string; apiKeyEnv: ApiKeyEnv };
type DecisionResult = { choice: Effort } | { failure: string; isPermanent: boolean } | { isCancelled: true };

const JEV_PROFILE: DecisionProfile = {
  name: 'jev', protocol: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKeyEnv: 'JEV_API_KEY',
};
const DECISION_API_PROFILE: DecisionProfile = {
  name: 'decision_api', protocol: 'openai', url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKeyEnv: 'DECISION_API_KEY',
};
const MAX_INPUT_ITEM_BYTES = 8192;
const MAX_RESPONSE_BYTES = 16 * 1024;

function resolveProfile(selected: unknown): DecisionProfile {
  if (selected === undefined || selected === 'jev') return JEV_PROFILE;
  if (selected === 'decision_api') return DECISION_API_PROFILE;
  throw new Error('System1 Thinking: profile must be jev or decision_api.');
}

function resolveInstructions(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || encoder.encode(value).length > 4096) {
    throw new Error(`System1 Thinking: ${name} must be nonblank text of at most 4096 UTF-8 bytes.`);
  }
  return value;
}

// Prefer line boundaries within 8 KiB.
function splitInputItems(input: string): string[] {
  const items: string[] = [];
  for (let rest = input; rest !== '';) {
    let item = truncateUtf8(rest, MAX_INPUT_ITEM_BYTES);
    if (item.length < rest.length && item.includes('\n')) item = item.slice(0, item.lastIndexOf('\n') + 1);
    items.push(item);
    rest = rest.slice(item.length);
  }
  return items;
}

function buildDecisionBody(profile: DecisionProfile, input: string, choices: readonly Effort[], rubricInstructions: string, effortDescriptions: EffortDescriptions): string {
  const items = splitInputItems(input);
  return JSON.stringify(profile.protocol === 'openai'
    ? {
      model: profile.model,
      input: items.map(text => ({ role: 'user', content: [{ type: 'input_text', text }] })),
      questions: [{ type: 'choice', name: 'reasoning_effort', instructions: rubricInstructions, choices: choices.map(value => ({ value, description: effortDescriptions[value] })) }],
    }
    : {
      model: profile.model,
      state: items.length === 1 ? input : items,
      questions: { reasoning_effort: { type: 'choice', instructions: rubricInstructions, criteria: Object.fromEntries(choices.map(choice => [choice, effortDescriptions[choice]])) } },
    });
}

function parseDecisionAnswer(profile: DecisionProfile, text: string, choices: readonly Effort[]): Effort | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const answers = (body as { answers?: unknown } | null)?.answers;
  let answer: unknown;
  if (profile.protocol === 'openai') {
    if (!Array.isArray(answers) || answers.length !== 1 || answers[0]?.name !== 'reasoning_effort') return undefined;
    answer = answers[0];
  } else {
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== 1) return undefined;
    answer = (answers as Record<string, unknown>).reasoning_effort;
  }
  const { type, choice } = (answer ?? {}) as { type?: unknown; choice?: unknown };
  return type === 'choice' ? choices.find(allowed => allowed === choice) : undefined;
}

function classifyDecisionResponse(profile: DecisionProfile, status: number, text: string, choices: readonly Effort[]): DecisionResult {
  if (status < 200 || status >= 300) {
    const details: string[] = [];
    if (encoder.encode(text).length <= MAX_RESPONSE_BYTES) {
      try {
        const error: unknown = (JSON.parse(text) as { error?: unknown } | null)?.error;
        if (error !== null && typeof error === 'object') {
          for (const field of ['type', 'code'] as const) {
            const value = (error as Record<string, unknown>)[field];
            if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value)) details.push(`${field}=${value}`);
          }
        }
      } catch {
        // Non-JSON error bodies still retain their HTTP status.
      }
    }
    return { failure: `HTTP ${status}${details.length ? ` (${details.join(', ')})` : ''}`, isPermanent: status >= 400 && status < 500 && status !== 408 && status !== 429 };
  }
  if (encoder.encode(text).length > MAX_RESPONSE_BYTES) return { failure: 'response_size: exceeds 16 KiB', isPermanent: false };
  const choice = parseDecisionAnswer(profile, text, choices);
  return choice === undefined ? { failure: 'invalid_response: missing or unsupported choice', isPermanent: false } : { choice };
}

// Host permissions require literal environment names.
function readApiKey($: EngineInterface, profile: DecisionProfile): Promise<string | undefined> {
  return profile.apiKeyEnv === 'JEV_API_KEY' ? $.env.get('JEV_API_KEY') : $.env.get('DECISION_API_KEY');
}

type DecisionSettings = { profile: DecisionProfile; choices: readonly Effort[]; timeoutMs: number; rubricInstructions: string; effortDescriptions: EffortDescriptions };

// Host fetch cannot cancel dispatched requests.
async function requestDecision(
  $: EngineInterface, settings: DecisionSettings, apiKey: string, input: string, signal: AbortSignal,
): Promise<DecisionResult> {
  const { profile, choices, timeoutMs } = settings;
  const request = $.http.fetch(profile.url, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: buildDecisionBody(profile, input, choices, settings.rubricInstructions, settings.effortDescriptions),
  });
  const deadline = new AbortController();
  const outcome = await Promise.race([
    request.then(response => ({ response }), () => ({ failure: 'transport: request failed' })),
    $.clock.sleep(timeoutMs, { signal: deadline.signal }).then(() => ({ failure: `timeout: timed out after ${timeoutMs} ms` }), () => ({ failure: 'cancelled: deadline stopped' })),
    new Promise<{ isCancelled: true }>(resolve => signal.addEventListener('abort', () => resolve({ isCancelled: true }), { once: true })),
  ]);
  deadline.abort();
  if ('isCancelled' in outcome) return outcome;
  if ('failure' in outcome) return { failure: outcome.failure, isPermanent: false };
  return classifyDecisionResponse(profile, outcome.response.status, outcome.response.text, choices);
}

export const register: Register = (on, options) => {
  const profile = resolveProfile(options.profile);
  const rubricInstructions = resolveInstructions(options.rubric_instructions, 'rubric_instructions');
  const effortDescriptions: EffortDescriptions = {
    low: resolveInstructions(options.lowEffortDescription, 'lowEffortDescription'),
    medium: resolveInstructions(options.mediumEffortDescription, 'mediumEffortDescription'),
    high: resolveInstructions(options.highEffortDescription, 'highEffortDescription'),
    xhigh: resolveInstructions(options.xhighEffortDescription, 'xhighEffortDescription'),
  };
  const isEnabledAtStart = options.enabled !== false;
  const minIndex = EFFORT_LEVELS.indexOf(options.minEffort as Effort);
  const maxIndex = EFFORT_LEVELS.indexOf(options.maxEffort as Effort);
  const boundedChoices = EFFORT_LEVELS.slice(Math.max(minIndex, 0), (maxIndex < 0 ? EFFORT_LEVELS.length - 1 : maxIndex) + 1);
  const turnInterval = Number(options.turnInterval ?? 1);
  const stepInterval = Number(options.stepInterval ?? 2);
  const timeoutMs = Number(options.timeoutMs ?? 3000);
  const evidenceBytes = Number(options.evidenceBytes ?? 8192);
  const decisionSettings: DecisionSettings = { profile, choices: boundedChoices, timeoutMs, rubricInstructions, effortDescriptions };
  const adaptsSubagents = options.subagents === true;
  let mainSpinnerId: string;
  const loops = new Map<string, LoopState>();
  const turnTexts = new Map<string, string>();

  function createLoop(isEnabled: boolean): LoopState {
    return {
      isEnabled, choices: boundedChoices, generation: 0, turnId: '', turnCount: 0, isTurnSelected: false, isDecisionDue: isEnabled,
      task: '', steer: '', failureCount: 0, retryAt: 0, decisionCount: 0, outcome: isEnabled ? 'on at loop start' : 'off',
    };
  }

  function mainLoop(): LoopState {
    const loop = loops.get(MAIN_LOOP) ?? createLoop(isEnabledAtStart && boundedChoices.length >= 2);
    loops.set(MAIN_LOOP, loop);
    return loop;
  }

  // Ignore native changes made while disabled.
  function setEnabled(loop: LoopState, isEnabled: boolean, outcome: string): void {
    Object.assign(loop, {
      isEnabled, generation: loop.generation + 1, effort: undefined, acceptedStep: undefined, isDecisionDue: isEnabled,
      failureCount: 0, retryAt: 0, blockReason: undefined, outcome,
    }, isEnabled ? { nativeModel: undefined, nativeEffort: undefined } : {});
  }

  function recordFailure(loop: LoopState, now: number, reason: string): void {
    loop.retryAt = now + RETRY_DELAYS_MS[Math.min(loop.failureCount, RETRY_DELAYS_MS.length - 1)]!;
    loop.failureCount++;
    loop.outcome = `${reason}; fallback ${loop.effort ?? 'native'} effort; retry after cooldown`;
  }

  function setAllEnabled(isEnabled: boolean, outcome: string): void {
    for (const loop of loops.values()) setEnabled(loop, isEnabled, outcome);
  }

  function describeLoop(loop: LoopState): string {
    const state = loop.blockReason === undefined ? (loop.isEnabled ? 'on' : 'off') : `blocked: ${loop.blockReason}`;
    const isInactive = loop.isEnabled && loop.nativeModel !== undefined && !isAdaptableEffort(loop.nativeEffort);
    return `System1 Thinking ${state}${isInactive ? ' (inactive: native effort is not an adjustable level)' : ''}; `
      + `effort ${loop.effort ?? `native (${loop.nativeEffort ?? 'unknown'})`}; `
      + `choices ${loop.choices.join('/')}; controller ${profile.name} (${profile.model}); decisions ${loop.decisionCount}; last: ${loop.outcome}.`;
  }

  on('ui.render', { component: 'Spinner' }, ($, event, next) => {
    const loop = loops.get(event.requestId === mainSpinnerId ? MAIN_LOOP : event.requestId);
    const hasError = loop !== undefined && (loop.failureCount > 0 || loop.blockReason !== undefined);
    if (!loop?.isEnabled || (loop.effort === undefined && !hasError)) return next(event);
    const label = `sys1·${loop.effort ?? ''}${hasError ? '·err' : ''}`;
    return next({ ...event, props: { ...event.props, suffix: `${event.props.suffix} ${label}` } });
  });

  on('session.start', async ($, event, next) => {
    mainSpinnerId = await $.session.id();
    await $.command.register({
      name: 'system1', description: 'Toggle System1 Thinking; paid decision-provider requests when on.',
      argumentHint: '[on|off|status]', immediate: true,
    });
    const loop = mainLoop();
    if (loop.isEnabled) {
      const generation = loop.generation;
      const isCurrent = () => loop.isEnabled && loop.generation === generation && loops.get(MAIN_LOOP) === loop;
      $.clock.after(0, async () => {
        try {
          if (!isCurrent()) return;
          const apiKey = await readApiKey($, profile);
          if (!isCurrent()) return;
          if (apiKey === undefined || apiKey.trim() === '') {
            $.ui.toast(`System1 Thinking: on · ${profile.name} · warmup skipped (${profile.apiKeyEnv} missing). /system1 status`);
            return;
          }
          const text = 'Hello world. This is a startup warmup.';
          const instructions = 'Is this a greeting?';
          const body = profile.protocol === 'typesafe'
            ? { model: profile.model, state: text, questions: { warmup: { type: 'noul', instructions } } }
            : { model: profile.model, input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
              questions: [{ type: 'choice', name: 'warmup', instructions, choices: [{ value: 'yes' }, { value: 'no' }] }] };
          const response = await $.http.fetch(profile.url, {
            method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (isCurrent()) {
            const status = response.status >= 200 && response.status < 300 ? 'succeeded' : `failed (HTTP ${response.status})`;
            $.ui.toast(`System1 Thinking: on · ${profile.name} · warmup ${status}. /system1 status`);
          }
        } catch {
          if (isCurrent()) $.ui.toast(`System1 Thinking: on · ${profile.name} · warmup failed (transport error). /system1 status`);
        }
      });
    } else {
      $.ui.toast('System1 Thinking: off · warmup skipped. /system1 on');
    }
    return next(event);
  });

  on('command.run', { command: 'system1' }, async ($, event) => {
    const loop = mainLoop();
    const action = event.args.trim() || (loop.isEnabled || loop.blockReason !== undefined ? 'off' : 'on');
    if (action === 'on' && boundedChoices.length < 2) {
      return { text: `System1 Thinking needs at least two choices; minEffort..maxEffort gives ${boundedChoices.join('/') || 'none'}.` };
    }
    if (action === 'on') {
      setEnabled(loop, true, 'enabled');
      $.ui.invalidate('ui.render');
    } else if (action === 'off') {
      // Off also reaches independently controlled subagents.
      setAllEnabled(false, 'disabled; native effort restored');
      $.ui.invalidate('ui.render');
    } else if (action !== 'status') {
      return { text: 'Usage: /system1 [on|off|status]; no argument toggles.' };
    }
    return { text: describeLoop(loop) };
  });

  on('turn.start', async ($, event, next) => {
    turnTexts.set(event.turnId, event.text);
    return next(event);
  });

  on('prompt.submit', async ($, event, next) => {
    const entered = await next(event);
    const loop = loops.get(MAIN_LOOP);
    if (loop !== undefined && event.turnId === loop.turnId && !event.wait && !('drop' in entered)) {
      const steer = truncateUtf8(entered.text, evidenceBytes / 3);
      loop.steer = steer === loop.task ? '' : steer;
    }
    return entered;
  });

  // Preserve enabled choice only across /clear.
  on('session.end', async ($, event, next) => {
    const keptEnabled = event.reason === 'clear' ? mainLoop().isEnabled : undefined;
    loops.clear();
    turnTexts.clear();
    if (keptEnabled !== undefined) loops.set(MAIN_LOOP, createLoop(keptEnabled));
    $.ui.invalidate('ui.render');
    return next(event);
  });

  on('turn.step', async function* ($, event, next) {
    const loopId = event.agentId ?? MAIN_LOOP;
    if (event.agentId !== undefined && !loops.has(loopId)) loops.set(loopId, createLoop(adaptsSubagents && mainLoop().isEnabled));
    const loop = loopId === MAIN_LOOP ? mainLoop() : loops.get(loopId)!;

    if (loop.turnId !== event.turnId) {
      Object.assign(loop, { turnId: event.turnId, turnCount: loop.turnCount + 1, acceptedStep: undefined, steer: '' });
      loop.isTurnSelected = (loop.turnCount - 1) % turnInterval === 0;
      loop.task = truncateUtf8(turnTexts.get(event.turnId) ?? '', evidenceBytes / 3);
      turnTexts.delete(event.turnId);
      loop.effort = undefined;
      $.ui.invalidate('ui.render');
    }

    if (loop.isEnabled && loop.nativeModel !== undefined && (event.model !== loop.nativeModel || event.effort !== loop.nativeEffort)) {
      Object.assign(loop, {
        generation: loop.generation + 1, effort: undefined, acceptedStep: undefined, isDecisionDue: true,
        outcome: `native settings changed to ${event.model}/${event.effort ?? 'none'}`,
      });
      $.ui.invalidate('ui.render');
    }
    Object.assign(loop, { nativeModel: event.model, nativeEffort: event.effort });

    const isDue = loop.isDecisionDue
      || (loop.isTurnSelected && (loop.acceptedStep === undefined || event.index - loop.acceptedStep >= stepInterval));
    if (!loop.isEnabled || !isAdaptableEffort(event.effort)) return yield* next(event);
    if (event.agentId !== undefined && loop.role === undefined) {
      const generation = loop.generation;
      const role = (await $.agent.list()).find(agent => agent.id === event.agentId)?.type;
      if (generation !== loop.generation || loops.get(loopId) !== loop || next.signal.aborted) return yield* next(event);
      if (role !== undefined) {
        const limits = ROLE_EFFORT_LIMITS.get(role);
        const choices = limits === undefined ? boundedChoices : boundedChoices.filter(choice =>
          EFFORT_LEVELS.indexOf(choice) >= EFFORT_LEVELS.indexOf(limits[0])
          && EFFORT_LEVELS.indexOf(choice) <= EFFORT_LEVELS.indexOf(limits[1]));
        if (choices.length === 0) {
          const answer = `System1 Thinking: global effort bounds conflict with role ${role}; adjust minEffort/maxEffort or disable System1.`;
          $.ui.toast(answer);
          // Hook exceptions fail open; a result without next prevents dispatch.
          return { turnId: event.turnId, index: event.index, answer, toolUses: [], stopReason: 'end_turn', usage: null };
        }
        Object.assign(loop, { role, choices });
      }
    }
    let fallbackEffort: Effort | undefined;
    if (loop.role !== undefined && ROLE_EFFORT_LIMITS.has(loop.role)) {
      const clampEffort = (effort: Effort): Effort => EFFORT_LEVELS[Math.max(EFFORT_LEVELS.indexOf(loop.choices[0]!), Math.min(EFFORT_LEVELS.indexOf(effort), EFFORT_LEVELS.indexOf(loop.choices.at(-1)!)))]!;
      fallbackEffort = clampEffort(event.effort);
      loop.effort = clampEffort(loop.effort ?? event.effort);
      $.ui.invalidate('ui.render');
    }
    if (loop.choices.length === 1) {
      loop.effort = loop.choices[0]!;
      return yield* next({ ...event, effort: loop.effort });
    }
    const now = await $.clock.now();
    if (loop.blockReason === undefined && isDue && now >= loop.retryAt) {
      const generation = loop.generation;
      const rows = event.agentId === undefined ? await $.session.messages() : await $.session.messages({ agentId: event.agentId });
      if (Array.isArray(rows)) {
        if (loop.task === '') loop.task = truncateUtf8(rows.findLast(row => row.role === 'user' && row.text !== '')?.text ?? '', evidenceBytes / 3);
        if (loop.task !== '' && generation === loop.generation && !next.signal.aborted) {
          const apiKey = await readApiKey($, profile);
          let result: DecisionResult = { failure: `credentials: ${profile.apiKeyEnv} is missing or empty`, isPermanent: true };
          if (apiKey !== undefined && apiKey.trim() !== '') {
            loop.decisionCount++;
            result = await requestDecision($, {
              ...decisionSettings, choices: loop.choices,
              rubricInstructions: `${rubricInstructions}\nConfigured reasoning baseline: ${event.effort}.`,
            }, apiKey, collectEvidence(loop, rows, evidenceBytes), next.signal);
          }
          const completedAt = await $.clock.now();
          // Discard stale results without counting failures.
          if (generation === loop.generation && !next.signal.aborted && !('isCancelled' in result)) {
            if ('choice' in result) {
              Object.assign(loop, { effort: result.choice, acceptedStep: event.index, isDecisionDue: false, failureCount: 0, retryAt: 0 });
              loop.outcome = `accepted ${result.choice} at turn ${loop.turnCount}, step ${event.index} in ${completedAt - now} ms`;
            } else {
              loop.effort = fallbackEffort;
              if (result.isPermanent) {
                loop.blockReason = `${profile.name}: ${result.failure}`;
                loop.outcome = `${loop.blockReason}; run /system1 on after fixing it`;
              } else {
                recordFailure(loop, completedAt, `${profile.name}: ${result.failure}`);
              }
            }
            $.ui.invalidate('ui.render');
          }
        }
      }
    }
    return yield* next(loop.isEnabled && loop.effort !== undefined ? { ...event, effort: loop.effort } : event);
  });
};
