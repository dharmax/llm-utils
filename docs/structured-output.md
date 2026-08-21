# Structured JSON Output & Validation

`@dharmax/llm-utils` provides an ultra-reliable, strictly typed structured output pipeline that combines provider-native JSON Schema enforcement, automatic markdown stripping, deterministic repair with `jsonrepair`, and local validation via Zod.

---

## 1. Using `asker.json()`

The simplest and recommended way to request typed structured responses:

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()

const TaskListSchema = z.object({
    project: z.string(),
    tasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        priority: z.enum(['low', 'medium', 'high']),
    })),
})

const result = await asker.json('Generate 3 tasks for building a login page', TaskListSchema)

if (result.ok && result.data) {
    // result.data is fully inferred as { project: string; tasks: Array<{ id: string; title: string; priority: 'low' | 'medium' | 'high' }> }
    for (const task of result.data.tasks) {
        console.log(`[${task.priority.toUpperCase()}] ${task.title}`)
    }
}
```

---

## 2. Pipeline Execution Steps

```
Prompt + Zod Schema
        │
        ▼
[1. Provider Native Formatting] ──► Sets OpenAI response_format / Gemini responseJsonSchema
        │
        ▼
[2. Raw Response Extraction]   ──► Strips markdown code blocks (```json ... ```) or trims prose
        │
        ▼
[3. JSON Parse & Repair]       ──► Native JSON.parse() → On failure, falls back to jsonrepair()
        │
        ▼
[4. Zod Schema Validation]     ──► Runs schema.safeParse()
        │
        ├─► Valid   ──► Returns { ok: true, data: T }
        └─► Invalid ──► If maxRetries > 0, performs bounded correction retry with diagnostic errors
```

---

## 3. Direct Parsing Functions

If you have a raw string from an external LLM call and want to parse and validate it:

```ts
import { parseStructuredJson, parseStructuredJsonResult, z } from '@dharmax/llm-utils'

const schema = z.object({ count: z.number() })

// 1. Throwing variant:
try {
    const data = parseStructuredJson('{count: 42}', schema)
    console.log(data.count) // 42 (repaired and validated)
} catch (err) {
    console.error(err.message)
}

// 2. Safe result variant:
const res = parseStructuredJsonResult('{count: 42}', schema)
if (res.ok) {
    console.log(res.data.count)
} else {
    console.error(res.message) // Detailed path and issue breakdown
}
```

---

## 4. Bounded Correction Retries

When validation fails on subtle constraints (e.g., regex, enum values, min lengths), pass `maxRetries` to automatically retry with the model:

```ts
const result = await asker.ask('Generate a user profile JSON', {
    schema: UserProfileSchema,
    maxRetries: 2, // Retries up to 2 times feeding validation error diagnostics back to the model
})
```
