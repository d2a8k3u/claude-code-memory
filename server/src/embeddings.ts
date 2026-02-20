/**
 * Local embeddings using @huggingface/transformers (all-MiniLM-L6-v2).
 * Model is loaded lazily on first use and cached for subsequent calls.
 * Produces 384-dimensional vectors for semantic similarity search.
 */

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

type Pipeline = (
  texts: string[],
  options?: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

let pipelineInstance: Pipeline | null = null;
let loadingPromise: Promise<Pipeline> | null = null;
let failCount = 0;
let lastFailTime = 0;
const MAX_RETRIES = 3;
const RETRY_COOLDOWN_MS = 60_000;

async function loadPipeline(): Promise<Pipeline> {
  if (pipelineInstance) return pipelineInstance;
  if (failCount >= MAX_RETRIES) throw new Error('Embeddings model failed to load after max retries');
  if (failCount > 0 && Date.now() - lastFailTime < RETRY_COOLDOWN_MS) {
    throw new Error('Embeddings retry cooldown active');
  }

  if (!loadingPromise) {
    loadingPromise = (async () => {
      try {
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline('feature-extraction', MODEL_NAME, {
          dtype: 'fp32',
        });
        pipelineInstance = extractor as unknown as Pipeline;
        failCount = 0;
        return pipelineInstance;
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

/**
 * Generate an embedding vector for the given text.
 * Returns null if embeddings are unavailable (model failed to load).
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await loadPipeline();
    const output = await pipe([text], { pooling: 'mean', normalize: true });
    const vectors = output.tolist();
    return new Float32Array(vectors[0]);
  } catch {
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling generateEmbedding() in a loop.
 */
export async function generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];

  try {
    const pipe = await loadPipeline();
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist();
    return vectors.map((v: number[]) => new Float32Array(v));
  } catch {
    return texts.map(() => null);
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Assumes vectors are normalized (which they are from our pipeline).
 * For normalized vectors, cosine similarity = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Serialize embedding to Buffer for SQLite storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize embedding from SQLite Buffer.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}

/**
 * Check if the embeddings model is available (loaded or loadable).
 */
export async function isEmbeddingsAvailable(): Promise<boolean> {
  if (failCount >= MAX_RETRIES) return false;
  if (pipelineInstance) return true;
  try {
    await loadPipeline();
    return true;
  } catch {
    return false;
  }
}

/** @internal Reset embedding state — used by tests only. */
export function resetEmbeddingState(): void {
  failCount = 0;
  lastFailTime = 0;
  pipelineInstance = null;
  loadingPromise = null;
}

export function warmEmbeddingModel(): void {
  loadPipeline().catch(() => {});
}

export { EMBEDDING_DIM };
