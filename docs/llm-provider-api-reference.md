# LLM Provider API Reference

Used by Hypatia model configuration. HDC refers to internal Shortround/Olivia inference servers.

---

## OpenRouter

**Base URL:** `https://openrouter.ai/api/v1`
**Auth:** `Authorization: Bearer <api_key>`
**Docs:** https://openrouter.ai/docs/api/reference/overview

### List Models
```
GET https://openrouter.ai/api/v1/models
Authorization: Bearer <api_key>
```
Response: `{ data: [{ id, name, description, context_length, ... }] }`
Model ID format: `provider/model-name` e.g. `anthropic/claude-3-5-sonnet`

### Chat Completions
```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "model": "anthropic/claude-3-5-sonnet",
  "messages": [{ "role": "user", "content": "..." }],
  "max_tokens": 1024,
  "temperature": 0.4
}
```
Response: OpenAI-compatible `{ choices: [{ message: { role, content } }] }`

---

## Pollinations

**Base URL:** `https://text.pollinations.ai`
**Auth:** None required for free tier
**Docs:** https://enter.pollinations.ai/api/docs

### List Models
```
GET https://text.pollinations.ai/models
```
Response: Array of model objects `[{ name, description, ... }]`
Use `name` field as the model identifier.

### Chat Completions (OpenAI-compatible)
```
POST https://text.pollinations.ai/openai/chat/completions
Content-Type: application/json

{
  "model": "openai",
  "messages": [{ "role": "user", "content": "..." }],
  "temperature": 0.4
}
```
Response: OpenAI-compatible format.

### Text Generation (simple)
```
POST https://text.pollinations.ai/
Content-Type: application/json

{
  "messages": [{ "role": "user", "content": "..." }],
  "model": "openai",
  "seed": 42,
  "jsonMode": false
}
```

---

## HDC (Internal — Shortround / Olivia)

OpenAI-compatible API served by vLLM or llama.cpp.

**Shortround endpoints:**
- Port 8011 → GPT-OSS-120B (GPU0)
- Port 8012 → Qwen3.5-35B (GPU1)

**Auth:** None (internal network only, Tailscale-gated)

### List Models
```
GET http://10.42.42.3:8011/v1/models
```
Response: `{ data: [{ id, object: "model", ... }] }`

### Chat Completions
```
POST http://10.42.42.3:8011/v1/chat/completions
Content-Type: application/json

{
  "model": "gpt-oss-120b",
  "messages": [...],
  "max_tokens": 1024,
  "temperature": 0.4,
  "stream": false
}
```

### Embeddings (Olivia)
TBD — endpoint to be configured when embedding model is deployed.

---

## Notes

- All three providers use OpenAI-compatible `/v1/chat/completions` format.
- Hypatia falls back through configured models in order until one succeeds.
- Token field can be left blank for HDC (internal) and Pollinations (free tier).
- Provider field controls which `/models` endpoint is called when fetching available models.
