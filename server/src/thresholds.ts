/**
 * Centralized similarity/distance thresholds used across the pipeline.
 * All values are cosine distances (0 = identical, 2 = opposite) unless noted.
 */
export const THRESHOLDS = {
  // --- Deduplication thresholds (cosine distance) ---
  /** Store-level and batch dedup — memories closer than this are exact duplicates */
  EXACT_DUPLICATE: 0.05,
  /** Consolidation merge — near-duplicates worth merging */
  NEAR_DUPLICATE: 0.08,
  /** Session-end episodic dedup (tightened from 0.10 to match consolidation) */
  EPISODIC_DEDUP: 0.08,
  /** Upper bound for "related but distinct" memories in findRelatedMemories */
  RELATED_UPPER: 0.35,

  // --- Pattern clustering thresholds (cosine distance) ---
  /** Pattern clustering lower bound — minimum similarity to cluster together (tightened from 0.40) */
  CLUSTER_MIN: 0.5,
  /** Pattern clustering upper bound — above this they're near-duplicates (tightened from 0.95) */
  CLUSTER_MAX: 0.85,
  /** Minimum average intra-cluster pairwise similarity — skip weak clusters */
  CLUSTER_QUALITY_MIN: 0.55,
  /** Cluster quality above this gets full importance (0.8), below gets reduced (0.6) */
  CLUSTER_QUALITY_STRONG: 0.65,
  /** Existing pattern coverage check — skip if centroid is this similar to an existing pattern (tightened from 0.50) */
  PATTERN_OVERLAP: 0.55,

  // --- Recency scoring (two-phase decay) ---
  /** Days in the steep short-term decay phase */
  RECENCY_SHORT_TERM_DAYS: 7,
  /** Score drop over the short-term phase (1.0 → 1 - DROP at boundary) */
  RECENCY_SHORT_TERM_DROP: 0.3,
  /** Time constant (τ) in days for the gradual long-term exponential decay */
  RECENCY_LONG_TERM_TAU: 120,

  // --- Content-length penalty ---
  /** Characters below which no penalty is applied */
  CONTENT_LENGTH_PENALTY_START: 500,
  /** Maximum penalty subtracted from final score */
  CONTENT_LENGTH_PENALTY_MAX: 0.15,
  /** Characters of excess for penalty to reach ~63% of max */
  CONTENT_LENGTH_PENALTY_SCALE: 2000,

  // --- Consolidation trigger ---
  /** Cumulative session weight that triggers auto-consolidation */
  CONSOLIDATION_WEIGHT_THRESHOLD: 10.0,
  /** Fallback session count gap if weight tracking is unavailable */
  CONSOLIDATION_SESSION_FALLBACK: 20,

  // --- Episodic archival thresholds ---
  /** Age in days after which low-value episodics are eligible for deletion */
  EPISODIC_ARCHIVE_AGE_DAYS: 60,
  /** Importance threshold — episodics below this are eligible for archival */
  EPISODIC_ARCHIVE_MAX_IMPORTANCE: 0.4,
  /** Access count threshold — only episodics accessed fewer times than this are eligible */
  EPISODIC_ARCHIVE_MAX_ACCESS: 1,

  // --- Scoring weights ---
  /** Default scoring weights for hybridSearchMemories */
  SCORING_WEIGHTS: { textScore: 0.5, importance: 0.2, recency: 0.2, access: 0.1 },
  /** Branch-channel preset: higher recency to favor recent work on the branch */
  SCORING_WEIGHTS_BRANCH: { textScore: 0.4, importance: 0.15, recency: 0.35, access: 0.1 },
  /** CWD-channel preset: higher importance for project-level knowledge */
  SCORING_WEIGHTS_CWD: { textScore: 0.4, importance: 0.3, recency: 0.2, access: 0.1 },
} as const;

export type ScoringWeights = {
  readonly textScore: number;
  readonly importance: number;
  readonly recency: number;
  readonly access: number;
};
