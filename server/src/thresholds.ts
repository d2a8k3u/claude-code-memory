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
  /** Minimum average Jaccard word overlap between cluster tasks — rejects format-only clusters */
  CLUSTER_TOPIC_OVERLAP_MIN: 0.15,

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
  // The former `access` weight (0.1) was dead in the autonomous flow: access_count
  // is only incremented by the memory_get MCP tool, never by hook-driven search or
  // injection, so it contributed ~0 there (and near-0 elsewhere). Its weight is
  // folded into `recency`, which also helps demote stale-but-on-topic memories.
  /** Default scoring weights for hybridSearchMemories */
  SCORING_WEIGHTS: { textScore: 0.5, importance: 0.2, recency: 0.3 },
  /** Branch-channel preset: higher recency to favor recent work on the branch */
  SCORING_WEIGHTS_BRANCH: { textScore: 0.4, importance: 0.15, recency: 0.45 },
  /** CWD-channel preset: higher importance for project-level knowledge */
  SCORING_WEIGHTS_CWD: { textScore: 0.4, importance: 0.3, recency: 0.3 },
} as const;

export type ScoringWeights = {
  readonly textScore: number;
  readonly importance: number;
  readonly recency: number;
};

// --- Per-type relevance thresholds for hook-triggered searches ---
export const TYPE_RELEVANCE = {
  semantic: 0.25,
  pattern: 0.4,
  procedural: 0.4,
  episodic: 0.25,
} as const;

// --- Always-on episodic recall for the UserPromptSubmit hook ---
// Episodic search runs every turn here (not just on recall-style phrasing), so the
// gate has to reject off-topic-but-recent history. The plain TYPE_RELEVANCE.episodic
// (0.25) tests the BLENDED finalScore, which a fresh importance-0.5 episodic clears on
// recency+importance alone (~0.40) with near-zero topical overlap. Two guards prevent
// that: a higher blended `baseline`, plus a `topicFloor` on the per-component textScore
// so recency/importance can never carry an off-topic episodic over the line. On an
// explicit recall-style prompt we relax both toward the old behavior so "did we already…"
// surfaces at least as much history as before.
export const EPISODIC_PROMPT_SUBMIT = {
  /** Off-recall: blended finalScore floor (above the ~0.40 a recent off-topic episodic reaches). */
  baseline: 0.45,
  /** Off-recall: minimum topical textScore (FTS+vector overlap) required to inject. */
  topicFloor: 0.12,
  /** Recall-style prompt: relax the blended floor back toward TYPE_RELEVANCE.episodic. */
  recallRelaxed: TYPE_RELEVANCE.episodic,
} as const;

// --- Per-hook caps by memory type ---
export const TYPE_LIMITS_PER_HOOK = {
  userPromptSubmit: {
    semantic: 3,
    pattern: 2,
    episodic: 2,
    total: 6,
  },
  preToolUse: {
    semantic: 3,
    pattern: 2,
    procedural: 1,
    episodic: 2,
    total: 3,
  },
  sessionStart: {
    semantic: 3,
    pattern: 2,
    episodic: 3,
    total: 10,
  },
} as const;

// --- Per-type decay and age-out rules ---
export const TYPE_DECAY = {
  episodic: { perSession: 0.08, ageOutDays: 90, staleImpThreshold: 0.05 },
  semantic: { perSession: 0.02, ageOutDays: Infinity, staleImpThreshold: 0 },
  procedural: { perSession: 0.02, ageOutDays: Infinity, staleImpThreshold: 0 },
  pattern: { perSession: 0.01, ageOutDays: 180, staleImpThreshold: 0.05 },
} as const;

// --- Co-occurrence reinforcement ---
// Conservative importance bump for a memory that was injected this session AND whose
// distinctive (non-path, non-command) title tokens reappear in the assistant reply.
// Reappearance is weak evidence the memory was relevant to the work — never proof it
// was "used" — so the delta is small, well below a single decay step, and capped by the
// 1.0 ceiling in boostImportance. File-path and command tokens are excluded because
// they co-occur by construction (the reply discusses the same files) and carry no signal.
export const REINFORCE_ON_COOCCURRENCE = 0.03;

// --- Directive framing escalation ---
// A pattern injected more than this many times without the rule sticking is a
// non-traction signal: escalate its prefix once (single bounded tier, not unbounded
// shouting) to a stronger "repeatedly recalled" framing. Based purely on the existing
// injection_count field — being injected often is weak evidence the rule is being
// ignored, never proof it was "used", so we cap the escalation at one tier.
export const PATTERN_FRAMING_ESCALATION_COUNT = 5;

// --- Importance boosts per type ---
export const TYPE_BOOST_ON_INJECT = {
  episodic: 0.02,
  semantic: 0.01,
  procedural: 0.01,
  pattern: 0.04,
} as const;

export const TYPE_BOOST_ON_ACCESS = {
  episodic: 0.05,
  semantic: 0.03,
  procedural: 0.03,
  pattern: 0.08,
} as const;

// --- Relation weight evolution ---
export const RELATION_WEIGHT = {
  strongThreshold: 0.5,
  floor: 0.05,
  decayPerSession: 0.005,
  // Co-injection (two memories surfaced together) is a weak signal — being shown
  // does not mean being used. Set equal to decayPerSession so injection ALONE is
  // net-neutral (it offsets decay but can't ratchet a relation toward 1.0), which
  // stops a stale sibling cluster from entrenching itself just by being injected.
  // Real reinforcement comes from co-ACCESS below.
  boostOnCoInject: 0.005,
  boostOnCoAccess: 0.1,
  coActivationPromotionCount: 3,
  sweepCadenceSessions: 20,
  sweepBatchSize: 100,
  sweepTimeBudgetMs: 500,
} as const;

// --- Relation sweep limits ---
export const RELATION_SWEEP = {
  cadenceSessions: 20,
  batchSize: 100,
  timeBudgetMs: 500,
  neighborCandidates: 20,
} as const;

export type RelationRuleInput =
  | { cosineDistance: number }
  | { similarity: number }
  | { sharedTagCount: number }
  | Record<string, never>;

export function computeInitialRelationWeight(
  rule: 'contradicts' | 'extends' | 'relates_to' | 'derived_from' | 'co_activation',
  input: RelationRuleInput,
): number {
  switch (rule) {
    case 'contradicts':
      return Math.max(0, 1 - (input as { cosineDistance: number }).cosineDistance);
    case 'extends':
      return (input as { similarity: number }).similarity;
    case 'relates_to':
      return Math.min(0.8, 0.3 + 0.1 * (input as { sharedTagCount: number }).sharedTagCount);
    case 'derived_from':
      return 0.5;
    case 'co_activation':
      return 0.45;
    default: {
      return rule;
    }
  }
}
