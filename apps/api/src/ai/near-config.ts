/** NEAR Cloud profiles with documented JSON and reasoning controls. No automatic model fallback. */
export const NEAR_AI_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEAR_AI_SECRET_PURPOSE = 'near-ai';
export const NEAR_AI_MODELS = {
  'z-ai/glm-5.3-flash': { reasoning_effort: 'low', thinking_token_budget: 32 },
  'Qwen/Qwen3.6-35B-A3B-FP8': { chat_template_kwargs: { enable_thinking: false } },
} as const;
