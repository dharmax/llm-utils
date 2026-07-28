# Structured output

`@dharmax/llm-utils` owns generic structured LLM-output behavior. Applications
retain prompt wording, model selection, budgets, provider policy, journals, and
application-specific schemas.

## Validation and provider schemas

Import `z` from this package:

```ts
import {z} from '@dharmax/llm-utils'

const schema = z.object({answer: z.string()})
```

The Zod schema is always the final local authority. `resolveStructuredOutput`
converts it with `z.toJSONSchema()` only when the schema has no behavior that
provider JSON Schema cannot enforce safely. Conversion never uses
`unrepresentable: 'any'`.

Transforms, preprocessors, and custom refinements cause generic JSON fallback.
An application may supply a separate `providerSchema` override when it has an
accurate transport schema for a more complex validation schema.

The returned plan records whether the provider schema was automatic, explicit,
or unavailable. Provider adapters additionally record whether native JSON
Schema transport was actually used.

## Provider transport

- OpenAI Chat Completions uses `response_format.json_schema`.
- Google GenerateContent uses `responseMimeType: application/json` and
  `responseJsonSchema`.
- Ollama `/api/generate` uses the JSON Schema object in `format`.
- Anthropic keeps its existing text transport; a schema request records a
  `provider_unsupported` fallback instead of inventing tool behavior.

Legacy `format: 'text' | 'json'` remains supported. New callers may use
`{type: 'text'}`, `{type: 'json'}`, or
`{type: 'json_schema', name, schema, strict}`.

## Parsing

Only object and array roots are accepted. Candidate priority is:

1. fenced JSON blocks in response order;
2. the complete response when it is object- or array-shaped;
3. balanced object/array candidates in source order.

Balanced extraction respects quoted strings and escapes. Direct parsing runs
before deterministic `jsonrepair`. Repair is attempted only for object- or
array-shaped candidates. With a Zod schema, parsing continues past a parseable
but invalid candidate and accepts the first candidate that validates.

Failures preserve structured parse/repair diagnostics, Zod issues, and the
original `ZodError`. `validateStructuredValue` applies the same Zod authority to
already-parsed checkpoint or persisted data without repairing it.

## Corrective calls and counts

`requestStructuredJson` performs exactly one substantive callback. Local
extraction and deterministic repair do not consume correction attempts.

When `correct` is supplied, `maxCorrectionAttempts` is the number of additional
corrective callback invocations after the initial response. Each callback
receives the failed raw response, failure kind, structured diagnostics, Zod
issues/error, correction number, validation schema, provider schema, and
response format. The package never constructs a repair prompt or injects the
raw response into one.

A provider failure returns `model_failed` immediately and is never treated as a
schema correction. Results report exact `substantiveCalls` and
`correctiveCalls`, all generation results, the accepted or relevant raw
response, and whether provider-native JSON Schema was used.
