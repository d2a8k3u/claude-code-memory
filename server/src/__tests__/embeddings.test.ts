import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, embeddingToBuffer, bufferToEmbedding, EMBEDDING_DIM, resetEmbeddingState, isEmbeddingsAvailable, generateEmbedding } from '../embeddings.js';

describe('EMBEDDING_DIM', () => {
  it('is 384', () => {
    assert.equal(EMBEDDING_DIM, 384);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical normalized vectors', () => {
    const vec = new Float32Array(384);
    const norm = 1 / Math.sqrt(384);
    for (let i = 0; i < 384; i++) vec[i] = norm;

    const similarity = cosineSimilarity(vec, vec);
    assert.ok(Math.abs(similarity - 1) < 0.001);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array(384).fill(0);
    const b = new Float32Array(384).fill(0);
    a[0] = 1;
    b[1] = 1;

    const similarity = cosineSimilarity(a, b);
    assert.equal(similarity, 0);
  });

  it('returns -1 for opposing normalized vectors', () => {
    const a = new Float32Array(4).fill(0);
    const b = new Float32Array(4).fill(0);
    a[0] = 1;
    b[0] = -1;

    const similarity = cosineSimilarity(a, b);
    assert.equal(similarity, -1);
  });

  it('computes correct dot product for known values', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot = 1*4 + 2*5 + 3*6 = 32
    assert.equal(cosineSimilarity(a, b), 32);
  });

  it('handles zero vectors', () => {
    const zero = new Float32Array(10).fill(0);
    const nonzero = new Float32Array(10).fill(1);

    assert.equal(cosineSimilarity(zero, zero), 0);
    assert.equal(cosineSimilarity(zero, nonzero), 0);
  });
});

describe('embeddingToBuffer / bufferToEmbedding roundtrip', () => {
  it('preserves values through serialization roundtrip', () => {
    const original = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      original[i] = Math.sin(i) * 0.5;
    }

    const buffer = embeddingToBuffer(original);
    const restored = bufferToEmbedding(buffer);

    assert.equal(restored.length, 384);
    for (let i = 0; i < 384; i++) {
      assert.ok(Math.abs(original[i] - restored[i]) < 1e-6, `Mismatch at index ${i}: ${original[i]} vs ${restored[i]}`);
    }
  });

  it('handles zero vector', () => {
    const zeros = new Float32Array(384);
    const buffer = embeddingToBuffer(zeros);
    const restored = bufferToEmbedding(buffer);

    assert.equal(restored.length, 384);
    for (let i = 0; i < 384; i++) {
      assert.equal(restored[i], 0);
    }
  });

  it('produces buffer with correct byte length', () => {
    const vec = new Float32Array(384);
    const buffer = embeddingToBuffer(vec);
    // Float32 = 4 bytes per element
    assert.equal(buffer.byteLength, 384 * 4);
  });

  it('handles small vectors', () => {
    const small = new Float32Array([1.5, -2.3, 0.0, 999.99]);
    const buffer = embeddingToBuffer(small);
    const restored = bufferToEmbedding(buffer);

    assert.equal(restored.length, 4);
    assert.ok(Math.abs(restored[0] - 1.5) < 1e-5);
    assert.ok(Math.abs(restored[1] - -2.3) < 1e-5);
    assert.equal(restored[2], 0);
    assert.ok(Math.abs(restored[3] - 999.99) < 0.1);
  });

  it('handles negative values', () => {
    const neg = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      neg[i] = -0.5;
    }

    const buffer = embeddingToBuffer(neg);
    const restored = bufferToEmbedding(buffer);

    for (let i = 0; i < 384; i++) {
      assert.ok(Math.abs(restored[i] - -0.5) < 1e-6);
    }
  });
});

describe('Embedding retry state machine', () => {
  beforeEach(() => {
    resetEmbeddingState();
  });

  it('resetEmbeddingState makes embeddings available again', async () => {
    resetEmbeddingState();
    const available = await isEmbeddingsAvailable();
    assert.ok(available, 'Embeddings should be available after reset');
  });

  it('generateEmbedding returns a vector after reset', async () => {
    resetEmbeddingState();
    const emb = await generateEmbedding('test retry');
    assert.ok(emb, 'Should produce an embedding after reset');
    assert.equal(emb.length, 384);
  });
});
