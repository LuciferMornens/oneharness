# Custom Models

Add custom providers and models (Ollama, vLLM, LM Studio, proxies) via `~/.prime/agent/models.json`.

## Table of Contents

- [Minimal Example](#minimal-example)
- [Full Example](#full-example)
- [Supported APIs](#supported-apis)
- [Provider Configuration](#provider-configuration)
- [Model Configuration](#model-configuration)
- [Overriding Built-in Providers](#overriding-built-in-providers)
- [Per-model Overrides](#per-model-overrides)
- [Anthropic Messages Compatibility](#anthropic-messages-compatibility)
- [OpenAI Compatibility](#openai-compatibility)

## Minimal Example

For local models (Ollama, LM Studio, vLLM), only `id` is required per model:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The `apiKey` is required but Ollama ignores it, so any value works.

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so Prime Agent sends the system prompt as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too.

You can set `compat` at the provider level to apply to all models, or at the model level to override a specific model. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## Full Example

Override defaults when you need specific values:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

The file reloads each time you open `/model`. Edit during session; no restart needed.

## Google AI Studio Example

Use `google-generative-ai` with a `baseUrl` to add models from Google AI Studio, including custom Gemma 4 entries:

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

The `baseUrl` is required when adding custom models to the `google-generative-ai` API type.

## Supported APIs

| API | Description |
|-----|-------------|
| `openai-completions` | OpenAI Chat Completions (most compatible) |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

Set `api` at provider level (default for all models) or model level (override per model).

## Provider Configuration

| Field | Description |
|-------|-------------|
| `baseUrl` | API endpoint URL |
| `api` | API type (see above) |
| `apiKey` | API key (see value resolution below) |
| `headers` | Custom headers (see value resolution below) |
| `authHeader` | Set `true` to add `Authorization: Bearer <apiKey>` automatically |
| `models` | Array of model configurations |
| `modelOverrides` | Per-model overrides for built-in models on this provider |

### Value Resolution

The `apiKey` and `headers` fields support three formats:

- **Shell command:** `"!command"` executes and uses stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **Environment variable:** Uses the value of the named variable
  ```json
  "apiKey": "MY_API_KEY"
  ```
- **Literal value:** Used directly
  ```json
  "apiKey": "sk-..."
  ```

For `models.json`, shell commands are resolved at request time. Prime Agent intentionally does not apply built-in TTL, stale reuse, or recovery logic for arbitrary commands. Different commands need different caching and failure strategies, and Prime Agent cannot infer the right one.

If your command is slow, expensive, rate-limited, or should keep using a previous value on transient failures, wrap it in your own script or command that implements the caching or TTL behavior you want.

`/model` availability checks use configured auth presence and do not execute shell commands.

### Custom Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## Model Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Model identifier (passed to the API) |
| `name` | No | `id` | Human-readable model label. Used for matching (`--model` patterns) and shown in model details/status text. |
| `api` | No | provider's `api` | Override provider's API for this model |
| `reasoning` | No | `false` | Supports extended thinking |
| `reasoningCapabilities` | No | omitted | Exact reasoning control type, selectable levels, and provider mappings (see below) |
| `thinkingLevelMap` | No | omitted | Deprecated compatibility map for legacy custom models (see below) |
| `input` | No | `["text"]` | Input types: `["text"]` or `["text", "image"]` |
| `contextWindow` | No | `128000` | Context window size in tokens |
| `maxTokens` | No | `16384` | Maximum output tokens |
| `cost` | No | all zeros | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}` (per million tokens) |
| `compat` | No | provider `compat` | Provider compatibility overrides. Merged with provider-level `compat` when both are set. |

Current behavior:
- `/model` and `prime-agent model list` list entries by model `id`.
- The configured `name` is used for model matching and detail/status text.

### Reasoning Capabilities

Use `reasoningCapabilities` on a model to describe exact model-specific thinking controls. `control` is `fixed`, `toggle`, `effort`, or `budget`. Keys in `levels` are Prime Agent thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Level entries are:

| Value | Meaning |
|-------|---------|
| string | Level is supported. For `effort`, this must be a non-empty native serialized value; for `toggle`, it is a support/mapping marker. |
| number | Level is supported. For `budget`, this must be a finite native integer token count; for `toggle`, it is a support/mapping marker. |
| `null` | Level is unsupported and hidden/skipped/clamped away |
| omitted | Level is unsupported |

For `control: "effort"`, every selectable level must map to a non-empty string. For `control: "budget"`, every selectable level must map to a finite integer accepted by the model API. Active OpenAI-compatible and OpenRouter budgets must be positive; active Anthropic and Bedrock Claude manual budgets must be at least 1,024. A numeric `off` mapping must use the route's real disable value, normally `0`; positive budgets and Google's `-1` dynamic-thinking sentinel are invalid at `off`. Anthropic/Bedrock structural disable support uses `supportsOff: true` instead of a fake zero budget. Google accepts documented `0` disable and `-1` dynamic sentinels on applicable budget-based Gemini families, but `-1` is only valid on active levels. On `openai-completions`, numeric budgets use top-level `reasoning_budget` with `thinkingFormat: "openai"`, or `reasoning: { max_tokens }` with `thinkingFormat: "openrouter"`; structural formats reject numeric budget contracts. The `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, and `mistral-conversations` APIs have string-only effort fields and reject numeric budget contracts. For `control: "toggle"`, structural `thinkingFormat` adapters (`zai`, `moonshot`, `qwen`, `qwen-chat-template`, and toggle-only `deepseek`) use the values only to resolve exact support/mapping and emit the format's documented enabled/disabled object or boolean. They do not copy the marker string to the wire.

Example for a token-budget model:

```json
{
  "id": "budget-reasoning-model",
  "reasoning": true,
  "reasoningCapabilities": {
    "control": "budget",
    "levels": {
      "minimal": 512,
      "low": 1024,
      "medium": 4096,
      "high": 8192
    }
  }
}
```

Example for a model where thinking cannot be disabled:

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "reasoningCapabilities": {
    "control": "fixed",
    "levels": {
      "high": "always"
    }
  }
}
```

Fixed controls are intrinsic, expose exactly one selectable level, and their internal values are not sent to providers. Legacy `thinkingLevelMap` overlays cannot add choices to a fixed route; set an explicit non-fixed `reasoningCapabilities` contract when the underlying route really supports selection. Omitting a request's reasoning selection preserves the provider default.

Example for a Qwen structural toggle. The marker strings describe the two selectable mappings; the adapter sends `enable_thinking: false` or `enable_thinking: true`, not the strings:

```json
{
  "id": "qwen-toggle-model",
  "reasoning": true,
  "reasoningCapabilities": {
    "control": "toggle",
    "levels": {
      "off": "disabled",
      "high": "enabled"
    }
  },
  "compat": {
    "supportsReasoningEffort": false,
    "thinkingFormat": "qwen"
  }
}
```

Migration: new configs should use `reasoningCapabilities`. `thinkingLevelMap` remains compatible with older custom models as a `string | null` map; numeric budgets must be declared under `reasoningCapabilities` with `control: "budget"`. Legacy models without either field retain `off`, `minimal`, `low`, `medium`, and `high`. For `modelOverrides`, `thinkingLevelMap` overlays the generated contract, then the effective contract is revalidated against its API and `thinkingFormat`; an explicitly supplied `reasoningCapabilities` object is authoritative. A partial legacy map must be expanded rather than copied directly: on a legacy OpenAI-compatible effort route, `{ high: "high" }` inherits `off: "off"`, `minimal: "minimal"`, `low: "low"`, and `medium: "medium"`, so include those values in exact `levels` and set `xhigh`/`max` to `null`; use explicit `null` for any inherited level that should instead be unsupported.

## Overriding Built-in Providers

Route a built-in provider through a proxy without redefining models:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

All built-in Anthropic models remain available. Existing OAuth or API key auth continues to work.

To merge custom models into a built-in provider, include the `models` array:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

Merge semantics:
- Built-in models are kept.
- Custom models are upserted by `id` within the provider.
- If a custom model `id` matches a built-in model `id`, the custom model replaces that built-in model.
- If a custom model `id` is new, it is added alongside built-in models.

## Per-model Overrides

Use `modelOverrides` to customize specific built-in models without replacing the provider's full model list.

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` supports these fields per model: `name`, `reasoning`, `reasoningCapabilities`, `thinkingLevelMap`, `input`, `cost` (partial), `contextWindow`, `maxTokens`, `headers`, `compat`.

Behavior notes:
- `modelOverrides` are applied to built-in provider models.
- Unknown model IDs are ignored.
- You can combine provider-level `baseUrl`/`headers` with `modelOverrides`.
- If `models` is also defined for a provider, custom models are merged after built-in overrides. A custom model with the same `id` replaces the overridden built-in model entry.

## Anthropic Messages Compatibility

For providers or proxies using `api: "anthropic-messages"`, use `compat.supportsEagerToolInputStreaming` to control Anthropic fine-grained tool streaming compatibility.

By default Prime Agent sends per-tool `eager_input_streaming: true`. If a proxy or Anthropic-compatible backend rejects that field, set `supportsEagerToolInputStreaming` to `false`. Prime Agent will omit `tools[].eager_input_streaming` and send the legacy `fine-grained-tool-streaming-2025-05-14` beta header for tool-enabled requests instead.

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `supportsEagerToolInputStreaming` | Whether the provider accepts per-tool `eager_input_streaming`. Default: `true`. Set to `false` to omit that field and use the legacy fine-grained tool streaming beta header on tool-enabled requests. |
| `supportsLongCacheRetention` | Whether the provider accepts Anthropic long cache retention (`cache_control.ttl: "1h"`) when cache retention is `long`. Default: `true`. |

## OpenAI Compatibility

For providers with partial OpenAI compatibility, use the `compat` field.

- Provider-level `compat` applies defaults to all models under that provider.
- Model-level `compat` overrides provider-level values for that model.

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `supportsStore` | Provider supports `store` field |
| `supportsDeveloperRole` | Use `developer` vs `system` role |
| `supportsReasoningEffort` | Support for `reasoning_effort` parameter |
| `supportsUsageInStreaming` | Supports `stream_options: { include_usage: true }` (default: `true`) |
| `maxTokensField` | Use `max_completion_tokens` or `max_tokens` |
| `requiresToolResultName` | Include `name` on tool result messages |
| `requiresAssistantAfterToolResult` | Insert an assistant message before a user message after tool results |
| `requiresThinkingAsText` | Convert thinking blocks to plain text |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` on all replayed assistant messages when reasoning is enabled |
| `thinkingFormat` | Use `openai`, `openrouter`, `deepseek`, `zai`, `moonshot`, `qwen`, or `qwen-chat-template` thinking parameters |
| `cacheControlFormat` | Use Anthropic-style `cache_control` markers on the system prompt, last tool definition, and last user/assistant text content. Currently only `anthropic` is supported. |
| `supportsStrictMode` | Include the `strict` field in tool definitions |
| `supportsLongCacheRetention` | Whether the provider accepts long cache retention when cache retention is `long`: `prompt_cache_retention: "24h"` for OpenAI prompt caching, or `cache_control.ttl: "1h"` when `cacheControlFormat` is `anthropic`. Default: `true`. |
| `openRouterRouting` | OpenRouter provider routing preferences. This object is sent as-is in the `provider` field of the [OpenRouter API request](https://openrouter.ai/docs/guides/routing/provider-selection). |
| `vercelGatewayRouting` | Vercel AI Gateway routing config for provider selection (`only`, `order`) |
| `orcaRouterRouting` | OrcaRouter fallback routing. Optional `models` list and `route: "fallback"`. |

`openrouter` sends `reasoning: { effort }`. `zai` and `moonshot` send `thinking: { type: "enabled" | "disabled" }`. `qwen` uses top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that require `chat_template_kwargs.enable_thinking`.

`cacheControlFormat: "anthropic"` is for OpenAI-compatible providers that expose Anthropic-style prompt caching through `cache_control` markers on text content and tool definitions.

Example:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway example:

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```

OrcaRouter fallback routing example:

```json
{
  "providers": {
    "orcarouter": {
      "baseUrl": "https://api.orcarouter.ai/v1",
      "apiKey": "ORCAROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "orcarouter/auto",
          "name": "OrcaRouter Auto",
          "compat": {
            "orcaRouterRouting": {
              "models": ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
              "route": "fallback"
            }
          }
        }
      ]
    }
  }
}
```
