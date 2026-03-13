/**
 * Centralized similarity/distance thresholds used across the pipeline.
 * All values are cosine distances (0 = identical, 2 = opposite).
 */
export const THRESHOLDS = {
  /** Store-level and batch dedup — memories closer than this are exact duplicates */
  EXACT_DUPLICATE: 0.05,
  /** Consolidation merge — near-duplicates worth merging */
  NEAR_DUPLICATE: 0.08,
  /** Session-end episodic dedup (tightened from 0.10 to match consolidation) */
  EPISODIC_DEDUP: 0.08,
  /** Upper bound for "related but distinct" memories in findRelatedMemories */
  RELATED_UPPER: 0.35,
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
} as const;
