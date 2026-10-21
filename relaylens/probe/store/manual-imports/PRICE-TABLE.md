# 全量价格表 (生成于 2026-10-11T09:48:00.546Z)

> 口径: 默认组优先,无默认取中位组; 非表达式价=$2/M×model_ratio×组倍率; tiered_expr 取首档系数×组倍率。缓存读=输入×cache_ratio(仅 cache_ratio>0)。

## memecode  (25 个模型, capturedAt=version a42d372ccf0b5dd13ecf71203521f9d2)

| 模型 | 计费 | 主口径组 | 输入 $/M | 输出 $/M | 缓存读 $/M |
|------|------|---------|--------|--------|-----------|
| `gpt-5.3-codex-spark` | token | Codex-Pro不降智(median) | 0.525 | 4.2 | 0.0525 |
| `claude-fable-5` | tiered_expr | Claudecode-Max纯享(median) | 16 | 80 | 1.6 |
| `gpt-6-astra` | tiered_expr | Codex-Pro不降智(median) | 3 | 15 | 0.3 |
| `claude-opus-5-5` | tiered_expr | Claudecode-Max(median) | 5.2 | 26 | 0.26 |
| `grok-4.6` | tiered_expr | Grok-不降智(median) | 0.6 | 1.8 | 0.09 |
| `grok-4.5` | tiered_expr | Grok-不降智(median) | 0.6 | 1.8 | 0.09 |
| `gpt-6-sol` | tiered_expr | Codex-Pro不降智(median) | 0.6 | 3 | 0.06 |
| `claude-sonnet-5-5` | tiered_expr | Claudecode-Max备用(median) | 2.6 | 13 | 0.26 |
| `gpt-5.6-terra` | tiered_expr | Codex-Pro(median) | 0.5 | 3 | 0.05 |
| `claude-opus-4-6` | tiered_expr | Claudecode-Max备用(median) | 6.5 | 32.5 | 0.65 |
| `claude-sonnet-5` | tiered_expr | Claudecode-Max(median) | 2.6 | 13 | 0.26 |
| `claude-opus-4-7` | tiered_expr | Claudecode-Max备用(median) | 6.5 | 32.5 | 0.65 |
| `grok-4.7` | tiered_expr | Grok-不降智(median) | 0.6 | 1.8 | 0.09 |
| `claude-haiku-4-5-20251001` | tiered_expr | test(median) | 1 | 5 | 0.1 |
| `gpt-5.5` | tiered_expr | Codex-Pro(median) | 1.25 | 7.5 | 0.125 |
| `glm-5.3` | tiered_expr | test(median) | 1.4 | 4.4 | 0.26 |
| `claude-fable-5-1` | tiered_expr | Claudecode-Max纯享(median) | 16 | 80 | 0.4 |
| `gpt-6.1-sol` | tiered_expr | Codex-Pro不降智(median) | 0.6 | 3 | 0.03 |
| `claude-haiku-5-5` | tiered_expr | Claudecode-Max(median) | 0.13 | 0.65 | 0.013 |
| `claude-haiku-4-5` | tiered_expr | Claudecode-Max备用(median) | 1.3 | 6.5 | 0.13 |
| `claude-opus-5` | tiered_expr | Claudecode-Max备用(median) | 6.5 | 32.5 | 0.65 |
| `gpt-5.6-sol` | tiered_expr | Codex-Pro不降智(median) | 1.2 | 6 | 0.12 |
| `gpt-5.6-luna` | tiered_expr | Codex-Pro(median) | 0.05 | 0.3 | 0.005 |
| `claude-opus-4-8` | tiered_expr | Claudecode-Max(median) | 6.5 | 32.5 | 0.65 |
| `claude-sonnet-4-6` | tiered_expr | Claudecode-Max纯享(median) | 4.8 | 24 | 0.48 |

## aixoras  (64 个模型, capturedAt=version a42d372ccf0b5dd13ecf71203521f9d2)

| 模型 | 计费 | 主口径组 | 输入 $/M | 输出 $/M | 缓存读 $/M |
|------|------|---------|--------|--------|-----------|
| `claude-opus-4-7` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `codex-auto-review` | token | GPT 优质(median) | 0.6125 | 4.9 | — |
| `gemini-3-pro-preview` | token | Gemini 优质(median) | 1.2 | 7.2 | 0.12 |
| `wan-3.0` | video_resolution | Seedance满血(median) | 75 | 75 | — |
| `claude-sonnet-5` | token | Claude-Max-外接(median) | 3.2 | 16 | — |
| `gpt-6-sol` | token | GPT 优质(median) | 0.7 | 3.5 | 0.07 |
| `gemini-3.8-flash` | token | Gemini 优质(median) | 0.45 | 2.25 | 0.045 |
| `glm-5.3` | token | GLM智谱(median) | 5.6 | 19.6 | 1.4 |
| `seedance-2.0-fast` | video_resolution | Seedance满血(median) | 75 | 75 | — |
| `gemini-3.1-flash-image-preview` | image_size | Gemini 生图(median) | 75 | 300 | — |
| `claude-opus-4-8` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `claude-opus-5` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `claude-sonnet-4-6` | token | Claude-Max-外接(median) | 4.8 | 24 | 0.48 |
| `grok-imagine-image-2.0` | 按次 | 按次$0.06 | — | — | — |
| `seedance-2.0` | video_resolution | 测试专用(median) | 75 | 75 | — |
| `seedance-2.5` | video_resolution | 测试专用(median) | 75 | 75 | — |
| `deepseek-v4-pro` | token | Deepseek(median) | 3.15 | 9.45 | 0.21 |
| `gemini-3-pro-image` | image_size | Gemini 生图(median) | 75 | 4500 | — |
| `glm-5.3-flash` | token | GLM智谱(median) | 0.105 | 0.35 | 0.021 |
| `grok-4.7` | token | Grok(median) | 0.4 | 1.2 | 0.1 |
| `minimax-h3` | 按次 | 按次$0.15 | — | — | — |
| `claude-fable-5.1` | token | 特价Claude(median) | 30 | 30 | — |
| `gpt-5.5` | token | GPT-企业级(median) | 3 | 18 | 0.3 |
| `gpt-5.6-terra` | tiered_expr | GPT-企业级(median) | 1.2 | 7.2 | 0.12 |
| `gemini-3.1-pro-preview` | token | Gemini 优质(median) | 1.2 | 7.2 | 0.12 |
| `gemini-3.7-flash` | token | Gemini 优质(median) | 0.45 | 2.25 | — |
| `gemini-3-pro-image-preview` | image_size | Gemini 生图(median) | 75 | 4500 | — |
| `gpt-image-2.5-flare` | image_size | IMAGE-2生图(median) | 75 | 150 | — |
| `seedance-2.0-mini` | video_resolution | Seedance满血(median) | 75 | 75 | — |
| `claude-sonnet-4-5` | token | 特价Claude(median) | 1.2 | 6 | 0.12 |
| `claude-opus-4-6-max` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `gemini-3.1-pro` | token | Gemini 优质(median) | 1.2 | 7.2 | 0.12 |
| `minimax-h3-f` | 按次 | 按次$0.24 | — | — | — |
| `qwen3.8-max` | token | Qwen千问(median) | 8.4 | 25.2 | — |
| `seedance-2.5-s` | video_resolution | Seedance满血(median) | 75 | 75 | — |
| `claude-fable-5` | token | Claude-Max-外接(median) | 16 | 80 | 1.6 |
| `gpt-5.6-sol` | tiered_expr | GPT-企业级(median) | 3 | 18 | 0.3 |
| `gpt-6.1-sol` | token | GPT 优质(median) | 0.7 | 3.5 | 0.035 |
| `deepseek-v4-flash` | token | Deepseek(median) | 0.7 | 3.15 | 0.035 |
| `gemini-3.5-flash` | token | Gemini 优质(median) | 0.9 | 5.4 | 0.09 |
| `grok-imagine-video` | 按次 | 按次$0.2 | — | — | — |
| `minimax-m3` | token | Mini-Max(median) | 1.47 | 5.88 | 0.294 |
| `claude-haiku-5-5` | token | Claude-Max-外接(median) | 0.8 | 4 | 0.08 |
| `gemini-3.1-flash-image` | image_size | Gemini 生图(median) | 75 | 300 | — |
| `kimi-k3` | token | KIMI(median) | 14 | 70 | 1.4 |
| `claude-fable-5-1` | token | Claude-Max-外接(median) | 16 | 80 | 0.4 |
| `claude-sonnet-5-5` | token | Claude-Max-外接(median) | 3.2 | 16 | 0.32 |
| `glm-5.2` | token | GLM智谱(median) | 5.6 | 19.6 | 1.4 |
| `grok-imagine-image` | 按次 | 按次$0.05 | — | — | — |
| `gpt-image-2.5-sunburst` | image_size | IMAGE-2生图(median) | 75 | 150 | — |
| `claude-opus-4-6` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `claude-opus-4-7-max` | token | Claude-Max-外接(median) | 8 | 40 | 0.8 |
| `gpt-5.4` | token | GPT-azure(median) | 5.5 | 33 | 0.55 |
| `claude-opus-5-5` | token | Claude-Max-外接(median) | 6.4 | 32 | 0.32 |
| `gpt-6-astra` | tiered_expr | GPT-企业级(median) | 6 | 30 | 0.6 |
| `gpt-5.4-mini` | token | GPT-azure(median) | 1.65 | 9.9 | 0.165 |
| `gpt-image-2` | image_size | IMAGE-VIP(median) | 112.5 | 225 | — |
| `grok-4.6` | tiered_expr | Grok(median) | 0.4 | 1.2 | 0.1 |
| `grok-imagine-video-1.5` | 按次 | 按次$0.2 | — | — | — |
| `seedream-5.0-pro` | image_size | IMAGE-2生图(median) | 75 | 75 | — |
| `gemini-nano-banana-2.1` | image_size | Gemini 生图(median) | 75 | 300 | — |
| `grok-4.5` | tiered_expr | Grok(median) | 0.4 | 1.2 | 0.1 |
| `gemini-3.6-flash` | token | Gemini 优质(median) | 0.81 | 4.5 | 0.09 |
| `gpt-5.6-luna` | tiered_expr | GPT-企业级(median) | 0.12 | 0.72 | 0.012 |

## aicost  (74 个模型, capturedAt=version a42d372ccf0b5dd13ecf71203521f9d2)

| 模型 | 计费 | 主口径组 | 输入 $/M | 输出 $/M | 缓存读 $/M |
|------|------|---------|--------|--------|-----------|
| `grok-4.5` | token | grok语言(median) | 0.3 | 0.9 | 0.075 |
| `claude-haiku-4-5-20251001` | token | claude-kiro渠道(median) | 0.11 | 0.55 | 0.011 |
| `gpt-6-astra` | tiered_expr | gpt-pro号池(median) | 2.5 | 12.5 | 0.25 |
| `seedance2.5-hs-720p` | 按次 | 按次$0.77 | — | — | — |
| `seedance2.5-md-720p-2` | 按次 | 按次$4 | — | — | — |
| `seedance2.0-fast-2` | 按次 | 按次$2.7 | — | — | — |
| `seedance2.5-dj-480p` | 按次 | 按次$0.5 | — | — | — |
| `gpt-image-2.5-flare` | 按次 | 按次$0.5 | — | — | — |
| `seedance2.5-900` | 按次 | 按次$5.2 | — | — | — |
| `claude-opus-5-5` | token | 正价kiro/满血(median) | 2 | 10 | 0.25 |
| `gpt-6-sol` | tiered_expr | gpt-pro大客户号池(median) | 0.6 | 3 | 0.06 |
| `seedance2.0-std` | 按次 | 按次$2.2 | — | — | — |
| `grok-4.6` | token | grok语言(median) | 0.3 | 0.9 | 0.075 |
| `gemini-3-pro-image-preview` | 按次 | 按次$0.12 | — | — | — |
| `seedance2.5-v3-720p-101010` | 按次 | 按次$3.3 | — | — | — |
| `gemini-3-flash-preview` | token | gemini-语言模型(median) | 0.2 | 1.2 | 0.0204 |
| `minimax-h3-768p-930-8-22` | 按次 | 按次$0.8 | — | — | — |
| `seedance2.5-dj-720p` | 按次 | 按次$1.05 | — | — | — |
| `seedance2.0-svip-900-720p` | 按次 | 按次$1.25 | — | — | — |
| `grok-imagine-video-1.5-preview` | 按次 | 按次$0.8 | — | — | — |
| `seedance2.5-10图` | 按次 | 按次$3.3 | — | — | — |
| `gemini-3.8-flash` | token | gemini-语言模型(median) | 0.3 | 1.5 | 0.03 |
| `seedance2.0-guanzhuan-480p` | 按次 | 按次$0.45 | — | — | — |
| `gpt-5.5` | tiered_expr | gpt-pro号池(median) | 1.25 | 7.5 | 0.125 |
| `seedance2.5-guanzhuan-480p` | 按次 | 按次$0.6 | — | — | — |
| `seedance2.5-30` | 按次 | 按次$6.5 | — | — | — |
| `seedance2.0-720p` | 按次 | 按次$4 | — | — | — |
| `gpt-image-2.5-sunburst` | 按次 | 按次$0.5 | — | — | — |
| `seedance2.5-9图` | 按次 | 按次$2.4 | — | — | — |
| `seedance2.0-md-720p` | 按次 | 按次$4.2 | — | — | — |
| `seedance2.5-vd-720p` | 按次 | 按次$3.5 | — | — | — |
| `deepseek-v4.1-flash-hc` | token | depsek(median) | 0.6 | 2.4 | 0.012 |
| `gemini-3-pro-preview` | token | gemini-语言模型(median) | 0.8 | 4.8 | 0.2 |
| `gemini-3.6-flash` | token | gemini-语言模型(median) | 0.6 | 3 | 0.06 |
| `seedance2.0-720p-100%` | 按次 | 按次$0.85 | — | — | — |
| `seedance2.0-900-3` | 按次 | 按次$1.05 | — | — | — |
| `claude-sonnet-4-6` | token | 正价kiro/满血(median) | 1.5 | 7.5 | 0.15 |
| `gpt-5.6-sol` | tiered_expr | gpt-pro号池(median) | 1.25 | 7.5 | 0.125 |
| `claude-opus-5` | token | 正价kiro/满血(median) | 2.5 | 12.5 | 0.25 |
| `seedance2.0-mini-480p` | 按次 | 按次$1.8 | — | — | — |
| `seedance2.5-guanzhuan-720p` | 按次 | 按次$1.19 | — | — | — |
| `grok-4.7` | token | grok语言(median) | 0.3 | 0.9 | 0.075 |
| `seedance2.5-kl` | 按次 | 按次$3.2 | — | — | — |
| `seedance2.5-v3-720p` | 按次 | 按次$4.5 | — | — | — |
| `claude-fable-5` | token | 正价kiro/满血(median) | 5 | 25 | 0.5 |
| `seedance2.5-hs-1080p` | 按次 | 按次$0.87 | — | — | — |
| `seedance2.0-hs-720p` | 按次 | 按次$8.3 | — | — | — |
| `gemini-3.1-pro-preview` | token | gemini-语言模型(median) | 0.8 | 4.8 | 0.08 |
| `seedance2.0-480p-100%` | 按次 | 按次$0.55 | — | — | — |
| `seedance2.0-1080p-100%` | 按次 | 按次$1.85 | — | — | — |
| `seedance2.0-tj-903` | 按次 | 按次$4.75 | — | — | — |
| `seedance-2.0-lec-720p` | 按次 | 按次$4.5 | — | — | — |
| `seedance2.5-doubao` | 按次 | 按次$3.5 | — | — | — |
| `gpt-image-2` | 按次 | 按次$0.445 | — | — | — |
| `deepseek-v4.1-flash` | token | depsek(median) | 0.6 | 2.4 | 0.012 |
| `seedance2.0-guanzhuan-720p` | 按次 | 按次$0.67 | — | — | — |
| `claude-sonnet-4-5-20250929` | token | claude-kiro渠道(median) | 0.33 | 1.65 | 0.66 |
| `gemini-3.7-flash` | token | gemini-语言模型(median) | 0.3 | 1.5 | 0.03 |
| `claude-opus-5.5` | token | 正价kiro/满血(median) | 2 | 10 | 0.25 |
| `seedance2.0-hs-1080p` | 按次 | 按次$10 | — | — | — |
| `claude-opus-4-6` | token | 正价kiro/满血(median) | 2.5 | 12.5 | 0.25 |
| `claude-opus-4-8` | token | 正价kiro/满血(median) | 2.5 | 12.5 | 0.25 |
| `gemini-3.1-flash-image-preview` | 按次 | 按次$0.1 | — | — | — |
| `seedance2.0-900-fast` | 按次 | 按次$1.8 | — | — | — |
| `seedance2.0-me` | 按次 | 按次$5.1 | — | — | — |
| `sora-v3-933-pro` | 按次 | 按次$4 | — | — | — |
| `claude-fable-5-1` | token | 正价kiro/满血(median) | 5 | 25 | 0.125 |
| `seedance2.5-vid` | 按次 | 按次$3 | — | — | — |
| `gemini-3.1-flash-lite` | token | gemini-语言模型(median) | 0.1 | 0.6 | — |
| `claude-opus-4-5-20251101` | token | claude-kiro渠道(median) | 0.0781 | 0.3905 | 0.00781 |
| `gpt-5.6-terra` | tiered_expr | gpt-pro号池(median) | 0.5 | 3 | 0.05 |
| `seedance2.0-v3-720p` | 按次 | 按次$3 | — | — | — |
| `seedance2.0-480p` | 按次 | 按次$2.5 | — | — | — |
| `claude-opus-4-7` | token | 正价kiro/满血(median) | 2.5 | 12.5 | 0.25 |
