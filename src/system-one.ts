import {childMetricsContext, emitMetric, type MetricsContext, type MetricsSink} from './metrics.ts'

export type SystemOneQuality = 'low' | 'medium' | 'high'

export type SystemOneValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { readonly [key: string]: SystemOneValue }
  | readonly SystemOneValue[]

/**
 * System-One state/instruction values accepted by JS backends.
 * Undefined object properties are valid input and are naturally omitted by JSON transports.
 */
export type SystemOneEntry =
  | string
  | { readonly [key: string]: SystemOneValue }
  | readonly SystemOneValue[]
  | null

export type SystemOneState = SystemOneEntry

export type SystemOneQuestion =
  | {
      type: 'choice'
      instructions?: SystemOneEntry
      criteria: Readonly<Record<string, SystemOneEntry>>
    }
  | {
      type: 'noul'
      instructions?: SystemOneEntry
      criteria?: {
        true?: SystemOneEntry
        false?: SystemOneEntry
      } | null
    }
  | {
      type: 'score'
      instructions?: SystemOneEntry
      /** Ordered rubric. Jev requires 2-10 levels; adapters may impose tighter limits. */
      criteria: readonly SystemOneEntry[]
    }

export interface SystemOneAnswer {
  readonly type?: 'choice' | 'score' | 'noul'
  readonly choice?: string
  readonly noul?: number
  readonly score?: number
  readonly confidence?: number
  readonly probabilities?: Readonly<Record<string, number>>
  readonly legend?: Readonly<Record<string, SystemOneEntry>>
  readonly [key: string]: unknown
}

export interface SystemOneAssessment {
  readonly answers: Readonly<Record<string, SystemOneAnswer>>
  readonly backendId: string
  readonly quality: SystemOneQuality
  readonly latencyMs: number
  readonly model?: string
  readonly usage?: Readonly<Record<string, unknown>>
}

export interface SystemOneAssessOptions {
  readonly metrics?: MetricsContext
  readonly metricsSink?: MetricsSink
}

export interface SystemOne {
  assess(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    options?: SystemOneAssessOptions,
  ): Promise<SystemOneAssessment | null>
}

export interface RemoteSystemOneOptions {
  readonly url: string
  readonly id?: string
  readonly quality?: SystemOneQuality
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

export class RemoteSystemOne implements SystemOne {
  constructor(private readonly options: RemoteSystemOneOptions) {}

  async assess(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    options: SystemOneAssessOptions = {},
  ): Promise<SystemOneAssessment | null> {
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3500)

    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.url.replace(/\/$/, '')}/classify`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({state, questions}),
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        this.record(options, questions, started, false, false, `HTTP ${response.status}`)
        return null
      }

      const body = await response.json() as {
        answers?: Record<string, SystemOneAnswer>
        model?: string
        usage?: Record<string, unknown>
        ok?: boolean
      }
      if (body.ok === false || !body.answers || typeof body.answers !== 'object') {
        this.record(options, questions, started, false, false, 'Malformed System-1 response')
        return null
      }

      const result = {
        answers: body.answers,
        backendId: this.options.id ?? 'remote-system-one',
        quality: this.options.quality ?? 'low',
        latencyMs: performance.now() - started,
        ...(body.model ? {model: body.model} : {}),
        ...(body.usage ? {usage: body.usage} : {}),
      } satisfies SystemOneAssessment
      this.record(options, questions, started, true, true)
      return result
    } catch (error) {
      this.record(options, questions, started, false, false, error instanceof Error ? error.message : String(error))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private record(
    options: SystemOneAssessOptions,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    started: number,
    success: boolean,
    available: boolean,
    error?: string,
  ): void {
    recordSystemOneMetric(
      options,
      this.options.id ?? 'remote-system-one',
      this.options.quality ?? 'low',
      questions,
      performance.now() - started,
      success,
      available,
      error,
    )
  }
}

export interface JevSystemOneOptions {
  readonly id?: string
  readonly quality?: SystemOneQuality
  readonly model?: string
  readonly apiKey?: string
  readonly baseURL?: string
  readonly timeoutMs?: number
  readonly load?: () => Promise<JevLike | null>
}

interface JevLike {
  systemOne(
    request: {
      state: SystemOneState
      questions: Readonly<Record<string, SystemOneQuestion>>
      model?: string
    },
    options?: {timeout?: number},
  ): Promise<{
    answers?: Record<string, SystemOneAnswer>
    model?: string
    usage?: Record<string, unknown>
  }>
}

/**
 * TypeSafe AI / Jev backend. The SDK is optional and loaded only when this
 * backend is used, keeping llm-utils free of a mandatory cloud dependency.
 */
export class JevSystemOne implements SystemOne {
  private client?: Promise<JevLike | null>

  constructor(private readonly options: JevSystemOneOptions = {}) {}

  async assess(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    options: SystemOneAssessOptions = {},
  ): Promise<SystemOneAssessment | null> {
    const started = performance.now()
    const client = await (this.options.load ? this.options.load() : this.loadClient())
    if (!client) {
      recordSystemOneMetric(
        options,
        this.options.id ?? 'jev',
        this.options.quality ?? 'low',
        questions,
        performance.now() - started,
        false,
        false,
        'TypeSafe AI SDK unavailable',
      )
      return null
    }

    try {
      const result = await client.systemOne(
        {
          state,
          questions,
          ...(this.options.model ? {model: this.options.model} : {}),
        },
        this.options.timeoutMs ? {timeout: this.options.timeoutMs} : undefined,
      )
      if (!result?.answers || typeof result.answers !== 'object') {
        recordSystemOneMetric(options, this.options.id ?? 'jev', this.options.quality ?? 'low', questions, performance.now() - started, false, true, 'Malformed Jev response')
        return null
      }

      const assessment = {
        answers: result.answers,
        backendId: this.options.id ?? 'jev',
        quality: this.options.quality ?? 'low',
        latencyMs: performance.now() - started,
        ...(result.model ? {model: result.model} : {}),
        ...(result.usage ? {usage: result.usage} : {}),
      } satisfies SystemOneAssessment
      recordSystemOneMetric(options, assessment.backendId, assessment.quality, questions, assessment.latencyMs, true, true)
      return assessment
    } catch (error) {
      recordSystemOneMetric(options, this.options.id ?? 'jev', this.options.quality ?? 'low', questions, performance.now() - started, false, true, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  private loadClient(): Promise<JevLike | null> {
    if (this.client) return this.client
    this.client = (async () => {
      try {
        const dynamicImport = new Function('specifier', 'return import(specifier)') as
          (specifier: string) => Promise<{TypeSafeClient?: new (config?: Record<string, unknown>) => JevLike}>
        const module = await dynamicImport('@typesafe-ai/sdk')
        if (!module.TypeSafeClient) return null
        return new module.TypeSafeClient({
          ...(this.options.apiKey ? {apiKey: this.options.apiKey} : {}),
          ...(this.options.baseURL ? {baseURL: this.options.baseURL} : {}),
          ...(this.options.model ? {defaultModel: this.options.model} : {}),
        })
      } catch {
        return null
      }
    })()
    return this.client
  }
}

export interface LayaSystemOneOptions {
  readonly id?: string
  readonly quality?: SystemOneQuality
  readonly load?: () => Promise<LayaLike | null>
}

interface LayaLike {
  systemOne(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
  ): Promise<{
    answers?: Record<string, SystemOneAnswer>
    model?: string
    usage?: Record<string, unknown>
  }>
}

let sharedLaya: LayaLike | null = null
let sharedLayaLoad: Promise<LayaLike | null> | null = null

async function loadLaya(): Promise<LayaLike | null> {
  if (sharedLaya) return sharedLaya
  if (sharedLayaLoad) return sharedLayaLoad

  sharedLayaLoad = (async () => {
    try {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as
        (specifier: string) => Promise<{Laya?: {load(): Promise<LayaLike>}}>
      const module = await dynamicImport('@receptron/laya')
      if (!module.Laya) return null
      sharedLaya = await module.Laya.load()
      return sharedLaya
    } catch {
      return null
    } finally {
      sharedLayaLoad = null
    }
  })()

  return sharedLayaLoad
}

export class LayaSystemOne implements SystemOne {
  constructor(private readonly options: LayaSystemOneOptions = {}) {}

  async assess(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    options: SystemOneAssessOptions = {},
  ): Promise<SystemOneAssessment | null> {
    const started = performance.now()
    const laya = await (this.options.load ?? loadLaya)()
    if (!laya) {
      recordSystemOneMetric(
        options,
        this.options.id ?? 'laya',
        this.options.quality ?? 'low',
        questions,
        performance.now() - started,
        false,
        false,
        'Laya unavailable',
      )
      return null
    }
    try {
      const result = await laya.systemOne(state, questions)
      if (!result?.answers || typeof result.answers !== 'object') {
        recordSystemOneMetric(options, this.options.id ?? 'laya', this.options.quality ?? 'low', questions, performance.now() - started, false, true, 'Malformed System-1 response')
        return null
      }

      const assessment = {
        answers: result.answers,
        backendId: this.options.id ?? 'laya',
        quality: this.options.quality ?? 'low',
        latencyMs: performance.now() - started,
        ...(result.model ? {model: result.model} : {}),
        ...(result.usage ? {usage: result.usage} : {}),
      } satisfies SystemOneAssessment
      recordSystemOneMetric(options, assessment.backendId, assessment.quality, questions, assessment.latencyMs, true, true)
      return assessment
    } catch (error) {
      recordSystemOneMetric(options, this.options.id ?? 'laya', this.options.quality ?? 'low', questions, performance.now() - started, false, true, error instanceof Error ? error.message : String(error))
      return null
    }
  }
}

export class FallbackSystemOne implements SystemOne {
  constructor(private readonly backends: readonly SystemOne[]) {}

  async assess(
    state: SystemOneState,
    questions: Readonly<Record<string, SystemOneQuestion>>,
    options: SystemOneAssessOptions = {},
  ): Promise<SystemOneAssessment | null> {
    for (const backend of this.backends) {
      const result = await backend.assess(state, questions, options)
      if (result) return result
    }
    return null
  }
}


function recordSystemOneMetric(
  options: SystemOneAssessOptions,
  backendId: string,
  quality: SystemOneQuality,
  questions: Readonly<Record<string, SystemOneQuestion>>,
  latencyMs: number,
  success: boolean,
  available: boolean,
  error?: string,
): void {
  const metrics = options.metrics ? childMetricsContext(options.metrics) : undefined
  emitMetric(options.metricsSink, {
    kind: 'system1',
    timestamp: new Date().toISOString(),
    backendId,
    quality,
    questionCount: Object.keys(questions).length,
    questionTypes: [...new Set(Object.values(questions).map(question => question.type))],
    available,
    latencyMs,
    success,
    error,
    traceId: metrics?.traceId,
    spanId: metrics?.spanId,
    parentSpanId: metrics?.parentSpanId,
    taskClass: metrics?.taskClass,
    tags: metrics?.tags,
  })
}
