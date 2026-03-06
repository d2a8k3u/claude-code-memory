/**
 * Cross-encoder reranking using Xenova/ms-marco-TinyBERT-L-2-v2.
 * Evaluates (query, passage) pairs jointly for more accurate relevance scoring
 * than bi-encoder similarity alone. Loaded lazily, with graceful fallback.
 *
 * Uses model + tokenizer directly (not the pipeline abstraction) because
 * ms-marco models have num_labels=1 and output raw logits — the pipeline's
 * softmax collapses all scores to 1.0.
 */

import type { ScoredMemoryRow } from './database.js';

const RERANKER_MODEL = 'Xenova/ms-marco-TinyBERT-L-2-v2';

const OVERFETCH_MULTIPLIER = 3;
const OVERFETCH_MAX = 60;

type Tokenizer = {
  (text: string, options?: Record<string, unknown>): Record<string, unknown>;
};

type Model = {
  (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array } }>;
};

type RerankerInstance = { tokenizer: Tokenizer; model: Model };

let instance: RerankerInstance | null = null;
let loadingPromise: Promise<RerankerInstance> | null = null;
let failCount = 0;
let lastFailTime = 0;
const MAX_RETRIES = 3;
const RETRY_COOLDOWN_MS = 60_000;

async function loadReranker(): Promise<RerankerInstance> {
  if (instance) return instance;
  if (failCount >= MAX_RETRIES) throw new Error('Reranker model failed to load after max retries');
  if (failCount > 0 && Date.now() - lastFailTime < RETRY_COOLDOWN_MS) {
    throw new Error('Reranker retry cooldown active');
  }

  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const { AutoModelForSequenceClassification, AutoTokenizer } = await import('@huggingface/transformers');
        const [model, tokenizer] = await Promise.all([
          AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, { dtype: 'fp32' }),
          AutoTokenizer.from_pretrained(RERANKER_MODEL),
        ]);
        instance = {
          tokenizer: tokenizer as unknown as Tokenizer,
          model: model as unknown as Model,
        };
        failCount = 0;
        return instance;
      } catch (err) {
        failCount++;
        lastFailTime = Date.now();
        loadingPromise = null;
        throw err;
      }
    })();
  }

  return loadingPromise;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export type RerankOutput = { results: ScoredMemoryRow[]; reranked: boolean };

export async function rerankResults(
  query: string,
  candidates: ScoredMemoryRow[],
  limit: number,
): Promise<RerankOutput> {
  if (candidates.length <= 1) {
    return { results: candidates.slice(0, limit), reranked: false };
  }

  let reranker: RerankerInstance;
  try {
    reranker = await loadReranker();
  } catch {
    return { results: candidates.slice(0, limit), reranked: false };
  }

  try {
    const scores: number[] = [];
    for (const c of candidates) {
      const passage = (c.title ? c.title + '\n\n' : '') + c.content;
      const inputs = reranker.tokenizer(query, { text_pair: passage, return_tensors: 'pt' });
      const output = await reranker.model(inputs);
      const logit = output.logits.data[0];
      scores.push(sigmoid(logit));
    }

    const scored = candidates.map((c, i) => ({
      ...c,
      score: scores[i],
    }));

    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, limit), reranked: true };
  } catch {
    return { results: candidates.slice(0, limit), reranked: false };
  }
}

export function overfetchLimit(desired: number): number {
  if (desired <= 0) return 0;
  return Math.min(desired * OVERFETCH_MULTIPLIER, OVERFETCH_MAX);
}

export function warmRerankerModel(): void {
  loadReranker().catch((err) => {
    console.warn(`[claude-memory] Reranker model warmup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export async function isRerankerAvailable(): Promise<boolean> {
  if (failCount >= MAX_RETRIES) return false;
  if (instance) return true;
  try {
    await loadReranker();
    return true;
  } catch {
    return false;
  }
}

/** @internal Reset reranker state — used by tests only. */
export function resetRerankerState(): void {
  failCount = 0;
  lastFailTime = 0;
  instance = null;
  loadingPromise = null;
}
