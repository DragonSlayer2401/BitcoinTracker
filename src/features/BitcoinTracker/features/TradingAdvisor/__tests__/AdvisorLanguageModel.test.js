/** @jest-environment node */
import {
  ADVISOR_LANGUAGE_MODEL_PRICING,
  ADVISOR_LANGUAGE_MODEL_PROMPT_VERSION,
  ADVISOR_LANGUAGE_MODEL_PROMPT_HASH,
  ADVISOR_LANGUAGE_MODEL_OUTPUT_SCHEMA,
  createAdvisorLanguageModelProvider,
  getAdvisorLanguageModelConfiguration,
  getAdvisorLanguageModelPublicConfiguration,
  getAdvisorLanguageModelRequest,
  getAdvisorLanguageModelUsageCost,
} from '@/services/research/tradingAdvisor/advisorLanguageModel.service';

jest.mock('server-only', () => ({}), { virtual: true });
const START = Date.UTC(2026, 9, 3, 12);
const SECRET = 'test-secret-never-send-or-log';
const config = (extra = {}) =>
  getAdvisorLanguageModelConfiguration({
    ADVISOR_LLM_ENABLED: 'true',
    ADVISOR_LLM_MODEL: 'gpt-6.1-sol',
    OPENAI_API_KEY: SECRET,
    ...extra,
  });
const evidence = (extra = {}) => ({
  available: true,
  snapshotId: 'snapshot-1',
  observedAt: START,
  expiresAt: START + 15000,
  accountVersion: 2,
  options: [{ id: 'hold', action: 'HOLD' }],
  points: [{ id: 'point-1', observedAt: START }],
  evidenceIds: ['point-1'],
  ...extra,
});
const output = (extra = {}) => ({
  action: 'HOLD',
  optionId: 'hold',
  snapshotId: 'snapshot-1',
  evidenceRefs: ['point-1'],
  reviewHorizon: '15s',
  ...extra,
});
const responseBody = (extra = {}) => ({
  id: 'resp_test',
  status: 'completed',
  model: 'gpt-6.1-sol',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(output()) }],
    },
  ],
  usage: { input_tokens: 1000, output_tokens: 300 },
  ...extra,
});
const response = (extra = {}) =>
  new Response(JSON.stringify(responseBody(extra)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function setup(options = {}) {
  let clock = START;
  const fetchImpl = jest.fn(async () => response());
  const reserveBudget = jest.fn(async () => ({ accepted: true, reservationId: 'reservation-1' }));
  const completeReservation = jest.fn(async () => undefined);
  const provider = createAdvisorLanguageModelProvider({
    configuration: config(),
    fetchImpl,
    reserveBudget,
    completeReservation,
    now: () => clock,
    ...options,
  });
  return {
    provider,
    fetchImpl,
    reserveBudget,
    completeReservation,
    setClock: (value) => {
      clock = value;
    },
    invoke: (extra = {}) =>
      provider.invoke({ evidence: evidence(), requestId: 'request-1', ...extra }),
  };
}

test('defaults disabled and requires explicit model, API key, enable flag and valid limits', () => {
  expect(getAdvisorLanguageModelConfiguration({}).disabledReason).toBe('not_enabled');
  expect(config({ OPENAI_API_KEY: '' }).disabledReason).toBe('api_key_missing');
  expect(config({ ADVISOR_LLM_MODEL: '' }).disabledReason).toBe('model_missing');
  expect(config({ ADVISOR_LLM_MODEL: 'invented-model' }).disabledReason).toBe('unsupported_model');
  for (const [key, value] of Object.entries({
    ADVISOR_LLM_TIMEOUT_MS: '60000',
    ADVISOR_LLM_MAX_OUTPUT_TOKENS: '100000',
    ADVISOR_LLM_DAILY_BUDGET_USD: '-1',
    ADVISOR_LLM_MIN_REQUEST_INTERVAL_MS: '1',
    ADVISOR_LLM_REASONING_EFFORT: 'invalid',
  }))
    expect(config({ [key]: value }).disabledReason).toBe('invalid_limits');
  expect(config().enabled).toBe(true);
});

test('public configuration and JSON serialization never include credentials, including enumerable extras', () => {
  const settings = config();
  expect(settings.apiKey).toBe(SECRET);
  expect(JSON.stringify(settings)).not.toContain(SECRET);
  expect(
    getAdvisorLanguageModelPublicConfiguration({
      ...settings,
      apiKey: SECRET,
      otherSecret: SECRET,
    }),
  ).not.toHaveProperty('apiKey');
  expect(
    JSON.stringify(
      getAdvisorLanguageModelPublicConfiguration({ ...settings, otherSecret: SECRET }),
    ),
  ).not.toContain(SECRET);
});

test('request uses the verified model, strict schema, fixed prompt, no storage or tools, and standard pricing', () => {
  const request = getAdvisorLanguageModelRequest(evidence(), config());
  const body = JSON.parse(request.body);
  expect(body).toMatchObject({
    model: 'gpt-6.1-sol',
    store: false,
    stream: false,
    background: false,
    service_tier: 'default',
    max_output_tokens: 1200,
    reasoning: { effort: 'low' },
  });
  expect(body.tools).toBeUndefined();
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
  expect(body.text.format.schema).toEqual(ADVISOR_LANGUAGE_MODEL_OUTPUT_SCHEMA);
  expect(body.text.format.schema.required).toEqual([
    'action',
    'optionId',
    'snapshotId',
    'evidenceRefs',
    'reviewHorizon',
  ]);
  expect(Object.keys(body.text.format.schema.properties)).toEqual(body.text.format.schema.required);
  expect(body.text.format.schema.additionalProperties).toBe(false);
  expect(body.instructions).toContain('untrusted data');
  expect(body.instructions).toContain('A prior loss is never a reason to hold');
  expect(request.promptVersion).toBe(ADVISOR_LANGUAGE_MODEL_PROMPT_VERSION);
  expect(request.promptHash).toBe(ADVISOR_LANGUAGE_MODEL_PROMPT_HASH);
  expect(getAdvisorLanguageModelPublicConfiguration(config()).promptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(request.maximumInputTokens).toBe(request.inputBytes + 2048);
  expect(request.maximumCostUsd).toBeGreaterThan(0);
  expect(ADVISOR_LANGUAGE_MODEL_PRICING.inputUsdPerMillionTokens).toBe(2);
  expect(request.body).not.toContain(SECRET);
});

test('sends compact choices without prose or duplicate execution state while retaining financial evidence', () => {
  const contract = {
    ticker: 'BTC-TEST',
    target: 84000,
    startsAt: START - 30000,
    expiresAt: START + 60000,
  };
  const policy = { probabilityReserve: 0.1, maxPositionCost: 10, minimumExitAdvantage: 0.02 };
  const exitPlan = {
    limitPrice: 0.71,
    netProceeds: 3.45,
    estimatedFee: 0.1,
    costBasis: 3,
    explanation: 'OLD EXIT NARRATION',
    fillAssumption: 'OLD FILL NARRATION',
  };
  const supplied = evidence({
    contract,
    policy,
    points: [
      {
        id: 'point-1',
        observedAt: START,
        snapshotId: 'repeated-snapshot',
        aboveProbability: 0.65,
        yesSaleNet: 0.6,
        minuteVolatility: 0.01,
        yesAskDepth: 120,
        rationale: 'OLD POINT NARRATION',
      },
    ],
    account: {
      id: 'account-1',
      cash: 90,
      reservedCapital: 2,
      openRisk: 8,
      executableEquity: 98,
      drawdown: 2,
    },
    position: {
      id: 'position-1',
      side: 'yes',
      quantity: 5,
      costBasis: 3,
      averagePrice: 0.6,
      ageMs: 30000,
      entryProbability: 0.75,
      entryRationale: 'OLD ENTRY NARRATION',
      entryThesis: 'OLD THESIS NARRATION',
    },
    previousPlan: {
      id: 'plan-1',
      action: 'HOLD',
      side: 'yes',
      quantity: 5,
      assessedAt: START - 15000,
      expired: false,
      rationale: 'OLD PLAN NARRATION',
      thesis: 'OLD PLAN THESIS',
      invalidationConditions: ['OLD CONDITION NARRATION'],
    },
    probabilityChange: -0.1,
    options: [
      {
        id: 'hold',
        action: 'HOLD',
        advice: {
          id: 'execution-id',
          contract,
          policy,
          accountVersion: 2,
          evaluatedAt: START,
          validUntil: START + 15000,
          side: 'yes',
          quantity: 5,
          probability: 0.65,
          limitPrice: 0.61,
          maxCost: 0,
          quotedFee: 0.08,
          expectedProceeds: 3,
          minimumNetProceeds: 2.95,
          holdExpectedValue: 3.25,
          expectedNetValue: -0.25,
          conservativeExpectedNetValue: -0.75,
          exitPlan,
        },
      },
    ],
    evidenceIds: ['point-1', 'account-1', 'position-1', 'plan-1'],
  });
  const original = JSON.stringify(supplied);
  const request = getAdvisorLanguageModelRequest(supplied, config());
  const compact = JSON.parse(JSON.parse(request.body).input[0].content[0].text).evidence;
  expect(compact).toMatchObject({
    contract,
    policy,
    account: supplied.account,
    probabilityChange: -0.1,
    position: {
      side: 'yes',
      quantity: 5,
      costBasis: 3,
      averagePrice: 0.6,
      ageMs: 30000,
      entryProbability: 0.75,
    },
    previousPlan: {
      action: 'HOLD',
      side: 'yes',
      quantity: 5,
      assessedAt: START - 15000,
      expired: false,
    },
    points: [
      {
        id: 'point-1',
        observedAt: START,
        aboveProbability: 0.65,
        yesSaleNet: 0.6,
        minuteVolatility: 0.01,
        yesAskDepth: 120,
      },
    ],
    options: [
      {
        id: 'hold',
        action: 'HOLD',
        terms: {
          side: 'yes',
          quantity: 5,
          probability: 0.65,
          limitPrice: 0.61,
          maxCost: 0,
          quotedFee: 0.08,
          expectedProceeds: 3,
          minimumNetProceeds: 2.95,
          holdExpectedValue: 3.25,
          expectedNetValue: -0.25,
          conservativeExpectedNetValue: -0.75,
          exitPlan: { limitPrice: 0.71, netProceeds: 3.45, estimatedFee: 0.1, costBasis: 3 },
        },
      },
    ],
  });
  expect(compact.options[0].terms).not.toHaveProperty('policy');
  expect(compact.options[0].terms).not.toHaveProperty('contract');
  expect(compact.options[0].terms).not.toHaveProperty('accountVersion');
  expect(JSON.stringify(compact)).not.toContain('NARRATION');
  expect(JSON.stringify(compact)).not.toContain('OLD PLAN THESIS');
  expect(JSON.stringify(compact).length).toBeLessThan(original.length);
  expect(JSON.stringify(supplied)).toBe(original);
});

test('bounds the entire UTF-8 request and refuses circular, future, expired or oversized evidence without spending', async () => {
  const settings = config({ ADVISOR_LLM_MAX_REQUEST_BYTES: '8192' });
  expect(
    getAdvisorLanguageModelRequest(evidence({ points: [{ text: '界'.repeat(5000) }] }), settings),
  ).toBeNull();
  const circular = evidence();
  circular.policy = circular;
  expect(getAdvisorLanguageModelRequest(circular, settings)).toBeNull();
  const fixture = setup();
  expect((await fixture.invoke({ evidence: evidence({ observedAt: START + 1 }) })).status).toBe(
    'invalid_input',
  );
  expect((await fixture.invoke({ evidence: evidence({ expiresAt: START }) })).status).toBe(
    'invalid_input',
  );
  expect((await fixture.invoke({ requestId: 'invalid id with spaces' })).status).toBe(
    'invalid_input',
  );
  expect(fixture.fetchImpl).not.toHaveBeenCalled();
  expect(fixture.reserveBudget).not.toHaveBeenCalled();
});

test('disabled mode and absent durable budget enforcement can never call a provider', async () => {
  const disabled = setup({ configuration: getAdvisorLanguageModelConfiguration({}) });
  expect((await disabled.invoke()).status).toBe('disabled');
  expect(disabled.fetchImpl).not.toHaveBeenCalled();
  const unguarded = setup({ reserveBudget: undefined });
  expect((await unguarded.invoke()).status).toBe('budget_unavailable');
  expect(unguarded.fetchImpl).not.toHaveBeenCalled();
});

test.each([{ available: false }, { available: undefined }, { options: [] }, { options: null }])(
  'does not spend on evidence without available choices: %j',
  async (unavailable) => {
    const fixture = setup();
    const result = await fixture.invoke({ evidence: evidence(unavailable) });
    expect(result.status).toBe('invalid_input');
    expect(fixture.reserveBudget).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  },
);

test('reserves worst-case spend before inference and records exact usage, identity and current timestamps', async () => {
  const fixture = setup();
  fixture.fetchImpl.mockImplementation(async () => {
    fixture.setClock(START + 1200);
    return response();
  });
  const result = await fixture.invoke();
  expect(result).toMatchObject({
    status: 'completed',
    model: 'gpt-6.1-sol',
    requestedModel: 'gpt-6.1-sol',
    requestId: 'request-1',
    snapshotId: 'snapshot-1',
    requestedAt: START,
    respondedAt: START + 1200,
    usage: { inputTokens: 1000, outputTokens: 300 },
    inferenceCostUsd: 0.005,
    responseId: 'resp_test',
    output: expect.objectContaining(output()),
  });
  expect(fixture.reserveBudget.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.fetchImpl.mock.invocationCallOrder[0],
  );
  expect(fixture.reserveBudget).toHaveBeenCalledWith(
    expect.objectContaining({
      maximumDailySpendUsd: 1,
      minimumRequestIntervalMs: 60000,
      reservationExpiresAt: START + 15000,
    }),
  );
  const [url, request] = fixture.fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  expect(request.redirect).toBe('error');
  expect(request.headers.Authorization).toBe(`Bearer ${SECRET}`);
  expect(fixture.completeReservation).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'completed',
      costUsd: 0.005,
      reservationId: 'reservation-1',
      inputTokens: 1000,
      outputTokens: 300,
    }),
  );
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(result.output.rationale).toBe(
    'The AI selected this supplied option using the cited market evidence.',
  );
  expect(result.output.thesis).toBe(
    'Reassess the selected option against updated market and account evidence.',
  );
});

test.each([
  [{ optionId: 'unavailable-exit' }, 'unknown_snapshot_or_option'],
  [{ action: 'EXIT' }, 'unknown_snapshot_or_option'],
  [{ evidenceRefs: ['invented-point'] }, 'unknown_evidence_reference'],
  [{ evidenceRefs: ['point-1', 'point-1'] }, 'output_schema_invalid'],
  [{ snapshotId: 'another-snapshot' }, 'snapshot_identity_changed'],
  [{ rationale: 'The model must not generate narration.' }, 'output_schema_invalid'],
  [{ reviewHorizon: '1h' }, 'output_schema_invalid'],
])(
  'rejects unsupplied or noncompact choices before they become recommendations: %j',
  async (patch, reason) => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(
      response({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(output(patch)) }],
          },
        ],
      }),
    );
    expect(await fixture.invoke()).toMatchObject({
      status: 'invalid_response',
      reason,
      output: null,
      inferenceCostUsd: 0.005,
    });
  },
);

test('durable denial or a reservation error never invokes the model and never leaks database errors', async () => {
  const denied = setup({
    reserveBudget: async () => ({ accepted: false, reason: 'daily-budget' }),
  });
  expect((await denied.invoke()).status).toBe('budget_denied');
  expect(denied.fetchImpl).not.toHaveBeenCalled();
  const failed = setup({
    reserveBudget: async () => {
      throw new Error(SECRET);
    },
  });
  const result = await failed.invoke();
  expect(result.status).toBe('budget_unavailable');
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(failed.fetchImpl).not.toHaveBeenCalled();
});

test('in-process rate and concurrency bounds prevent duplicate simultaneous provider calls', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = setup();
  fixture.fetchImpl.mockImplementation(async () => {
    await gate;
    return response();
  });
  const first = fixture.invoke();
  expect((await fixture.invoke({ requestId: 'request-2' })).status).toBe('busy');
  release();
  await first;
  expect((await fixture.invoke({ requestId: 'request-3' })).status).toBe('rate_limited');
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  expect(fixture.reserveBudget).toHaveBeenCalledTimes(1);
});

test('valid usage costs are finite and malformed usage cannot cause an understated charge', async () => {
  expect(
    getAdvisorLanguageModelUsageCost({
      input_tokens: 1000,
      output_tokens: 300,
      input_tokens_details: { cached_tokens: 1000 },
    }).inferenceCostUsd,
  ).toBe(0.005);
  for (const usage of [
    null,
    {},
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: NaN },
    { input_tokens: 1.2, output_tokens: 2 },
    { input_tokens: 1, output_tokens: '2' },
  ])
    expect(getAdvisorLanguageModelUsageCost(usage)).toBeNull();
  const fixture = setup();
  fixture.fetchImpl.mockResolvedValue(response({ usage: { input_tokens: -1, output_tokens: 0 } }));
  const result = await fixture.invoke();
  expect(result.usage).toBeNull();
  expect(result.inferenceCostUsd).toBe(fixture.reserveBudget.mock.calls[0][0].maximumCostUsd);
});

test.each([
  [
    'refused',
    {
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: SECRET }] },
      ],
    },
  ],
  ['incomplete', { status: 'incomplete' }],
  ['invalid_response', { model: 'gpt-different' }],
  ['invalid_response', { output: [{ type: 'function_call', name: 'place_order' }] }],
  [
    'invalid_response',
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'not json' }],
        },
      ],
    },
  ],
  [
    'invalid_response',
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(output({ quantity: 100 })) }],
        },
      ],
    },
  ],
  [
    'invalid_response',
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(output({ snapshotId: 'other' })) }],
        },
      ],
    },
  ],
])(
  'records %s safely without accepting refused, incomplete or malformed model output',
  async (status, body) => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(response(body));
    const result = await fixture.invoke();
    expect(result.status).toBe(status);
    expect(result.output).toBeNull();
    expect(result.inferenceCostUsd).toBe(0.005);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  },
);

test('late completed responses remain charged but are not accepted as a current plan', async () => {
  const fixture = setup();
  fixture.fetchImpl.mockImplementation(async () => {
    fixture.setClock(START + 16000);
    return response();
  });
  const result = await fixture.invoke();
  expect(result.status).toBe('invalid_response');
  expect(result.reason).toBe('response_expired');
  expect(result.output).toBeNull();
  expect(result.inferenceCostUsd).toBe(0.005);
});

test('timeouts abort the request, retain conservative spend and release in-process concurrency', async () => {
  jest.useFakeTimers();
  try {
    const fixture = setup({ configuration: config({ ADVISOR_LLM_TIMEOUT_MS: '1000' }) });
    fixture.fetchImpl.mockImplementation(async () => new Promise(() => {}));
    const pending = fixture.invoke();
    await jest.advanceTimersByTimeAsync(1001);
    const result = await pending;
    expect(result.status).toBe('timeout');
    expect(fixture.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(result.inferenceCostUsd).toBe(fixture.reserveBudget.mock.calls[0][0].maximumCostUsd);
    expect(fixture.completeReservation).toHaveBeenCalledTimes(1);
    expect((await fixture.invoke({ requestId: 'next-request' })).status).toBe('rate_limited');
  } finally {
    jest.useRealTimers();
  }
});

test('caller cancellation is honored before and during inference without exposing provider error text', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = setup();
  expect((await before.invoke({ signal: controller.signal })).status).toBe('canceled');
  expect(before.reserveBudget).not.toHaveBeenCalled();
  const active = new AbortController();
  const fixture = setup();
  fixture.fetchImpl.mockImplementation(async () => {
    active.abort();
    throw new Error(SECRET);
  });
  const result = await fixture.invoke({ signal: active.signal });
  expect(result.status).toBe('canceled');
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(result.inferenceCostUsd).toBeGreaterThan(0);
});

test('HTTP errors, oversized replies and failed accounting return safe failures without retries', async () => {
  const http = setup();
  http.fetchImpl.mockResolvedValue(new Response(SECRET, { status: 401 }));
  const error = await http.invoke();
  expect(error.status).toBe('provider_error');
  expect(error.reason).toBe('provider_authentication_failed');
  expect(JSON.stringify(error)).not.toContain(SECRET);
  expect(http.fetchImpl).toHaveBeenCalledTimes(1);
  const oversized = setup();
  oversized.fetchImpl.mockResolvedValue(new Response('a'.repeat(129 * 1024), { status: 200 }));
  expect((await oversized.invoke()).status).toBe('provider_error');
  const failed = setup({
    completeReservation: async () => {
      throw new Error(SECRET);
    },
  });
  const failedResult = await failed.invoke();
  expect(failedResult.status).toBe('budget_unavailable');
  expect(failedResult.output).toBeNull();
  expect(JSON.stringify(failedResult)).not.toContain(SECRET);
});

test.each([
  [400, 'invalid_json_schema', 'provider_request_rejected'],
  [403, 'invalid_request_error', 'provider_access_denied'],
  [429, 'insufficient_quota', 'provider_quota_exhausted'],
  [429, 'rate_limit_exceeded', 'provider_rate_limited'],
])('records actionable, sanitized HTTP diagnostics for %s', async (status, code, reason) => {
  const fixture = setup();
  fixture.fetchImpl.mockResolvedValue(
    new Response(JSON.stringify({ error: { code, message: SECRET } }), { status }),
  );
  const result = await fixture.invoke();
  expect(result).toMatchObject({
    status: 'provider_error',
    reason,
    httpStatus: status,
    providerErrorCode: code,
  });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
});

test('quota failures pause paid requests until provider restart, including message-only quota errors', async () => {
  const fixture = setup();
  fixture.fetchImpl.mockResolvedValue(
    new Response(JSON.stringify({ error: 'API account quota exhausted; check billing.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  expect((await fixture.invoke()).reason).toBe('provider_quota_exhausted');
  fixture.setClock(START + 60000);
  const retry = await fixture.invoke({ requestId: 'request-2' });
  expect(retry).toMatchObject({ reason: 'provider_quota_exhausted', inferenceCostUsd: 0 });
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  expect(fixture.reserveBudget).toHaveBeenCalledTimes(1);
});
