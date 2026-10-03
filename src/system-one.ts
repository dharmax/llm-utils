export type SystemOneQuality = 'low' | 'medium' | 'high'

export type SystemOneQuestion =
  | {
      type: 'choice'
      instructions: string
      criteria: Readonly<Record<string, string>>
    }
  | {
      type: 'noul'
      instructions: string
    }
  | {
      type: 'score'
      instructions: string
      criteria: readonly string[]
    }

export interface SystemOneAnswer {
  readonly choice?: string
  readonly noul?: number
  readonly score?: number
  readonly probabilities?: Readonly<Record<string, number>>
  readonly [key: string]: unknown
}

export interface SystemOneAssessment {
  readonly answers: Readonly<Record<string, SystemOneAnswer>>
  readonly backendId: string
  readonly quality: SystemOneQuality
  readonly latencyMs: number
  readonly usage?: Readonly<Record<string, unknown>>
}

export interface SystemOne {
  assess(
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, SystemOneQuestion>>,
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
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, SystemOneQuestion>>,
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
      if (!response.ok) return null

      const body = await response.json() as {
        answers?: Record<string, SystemOneAnswer>
        usage?: Record<string, unknown>
        ok?: boolean
      }
      if (body.ok === false || !body.answers || typeof body.answers !== 'object')
        return null

      return {
        answers: body.answers,
        backendId: this.options.id ?? 'remote-system-one',
        quality: this.options.quality ?? 'low',
        latencyMs: performance.now() - started,
        ...(body.usage ? {usage: body.usage} : {}),
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface LayaSystemOneOptions {
  readonly id?: string
  readonly quality?: SystemOneQuality
  readonly load?: () => Promise<LayaLike | null>
}

interface LayaLike {
  systemOne(
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, SystemOneQuestion>>,
  ): Promise<{
    answers?: Record<string, SystemOneAnswer>
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
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, SystemOneQuestion>>,
  ): Promise<SystemOneAssessment | null> {
    const laya = await (this.options.load ?? loadLaya)()
    if (!laya) return null

    const started = performance.now()
    try {
      const result = await laya.systemOne(state, questions)
      if (!result?.answers || typeof result.answers !== 'object') return null

      return {
        answers: result.answers,
        backendId: this.options.id ?? 'laya',
        quality: this.options.quality ?? 'low',
        latencyMs: performance.now() - started,
        ...(result.usage ? {usage: result.usage} : {}),
      }
    } catch {
      return null
    }
  }
}

export class FallbackSystemOne implements SystemOne {
  constructor(private readonly backends: readonly SystemOne[]) {}

  async assess(
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, SystemOneQuestion>>,
  ): Promise<SystemOneAssessment | null> {
    for (const backend of this.backends) {
      const result = await backend.assess(state, questions)
      if (result) return result
    }
    return null
  }
}
