# Local model options for the benchmark

**Why this is here:** the benchmark's first full run died halfway through because the
provider's balance ran out. A local model has no balance, no rate limit and no cost, so
the measurement can be reproduced offline. The trade is wall time and model size.

The harness supports it: `--model ollama/ornith-1.5:9b` works, and it turns the local
model's reasoning off automatically (see below).

## What is installed (ollama list)

| Model | Size | Chat? | Tool calls? | Verdict |
|---|---|---|---|---|
| `ornith-1.5:9b` | 6.6 GB | yes | yes | **the only usable local candidate** |
| `clef-flash:latest` | 12 GB | **no** | no | a *decision* model (`/v1/systemone`), non-autoregressive |
| `laya:latest` | 846 MB | no | - | no chat |
| `tev1:0.8b` | 796 MB | no | - | no chat |
| `deepseek-ocr` / `glm-ocr` | 6.7 / 2.2 GB | - | - | OCR only |
| `qwen3-embedding` / `embeddinggemma-2` | 0.6 / 1.3 GB | - | - | embeddings |

Machine: Apple M4, 24 GB RAM.

## ornith-1.5:9b through OpenCode

Works end to end: loads the plugin, makes tool calls, answers correctly.

**Thinking is the problem.** With thinking on, a 141-token response took **81 seconds**
(1.7 tok/s) and one full run took 644 s. With `think: false` at the Ollama API, the same
call took **10.9 s**.

OpenCode's own switch is the model's reasoning config, not the provider's options:

```jsonc
"provider": {
  "ollama": {
    "models": {
      "ornith-1.5:9b": { "reasoning": { "supported": true, "toggle": false } }
    }
  }
}
```

With it: **28-42 s per run**, correct answers, tool calls recorded.

Note: `provider.ollama.options.think = false` does **not** work — it made the run call the
tool 5 times instead of once.

## The comparison that matters

| Model | Per run | Cost | Notes |
|---|---|---|---|
| `ollama-cloud/minimax-m3.1-flash` | ~9 s | paid | **the default**; fast, reliable tool calls |
| `ollama/ornith-1.5:9b` | 28-93 s | free | **the local fallback**; needs the reasoning toggle |
| `ollama-cloud/deepseek-v4.1-flash` | 5-30 s | paid | used for the first 120-run matrix |
| `deepseek/deepseek-flash` | 5-35 s | paid | **out of credit** (402 Insufficient Balance) |

`minimax-m3.1-flash` makes a lot of tool calls: on `list-all` it called `task_list` nine
times — once unfiltered, then once per column — to verify the unfiltered answer. That
is real behaviour, not a counting artifact: the calls have distinct timestamps and
distinct `status` arguments. It is worth knowing before reading its call counts against
another model's.

## The honest trade

Local buys: no balance limit, no cost, no rate limit, reproducible offline.

Local costs: ~8x the wall time per run, and a **9B model** rather than a frontier one —
so the absolute numbers are not comparable across models. The *relative* comparison
between surfaces is still valid, because every shape is measured with the same model.

The 120-run matrix took ~9 minutes at concurrency 4 on ollama-cloud. On local it would
be ~40-60 minutes.
