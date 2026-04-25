import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPE_RELEVANCE,
  TYPE_LIMITS_PER_HOOK,
  TYPE_DECAY,
  TYPE_BOOST_ON_INJECT,
  TYPE_BOOST_ON_ACCESS,
  RELATION_WEIGHT,
  computeInitialRelationWeight,
} from '../thresholds.js';

test('TYPE_RELEVANCE has a threshold for each non-working type', () => {
  assert.equal(TYPE_RELEVANCE.semantic, 0.25);
  assert.equal(TYPE_RELEVANCE.pattern, 0.4);
  assert.equal(TYPE_RELEVANCE.procedural, 0.4);
  assert.equal(TYPE_RELEVANCE.episodic, 0.25);
});

test('TYPE_LIMITS_PER_HOOK caps UserPromptSubmit at 6 total', () => {
  const caps = TYPE_LIMITS_PER_HOOK.userPromptSubmit;
  assert.equal(caps.total, 6);
  assert.equal(caps.semantic + caps.pattern + caps.episodic, 7); // sum before cap
});

test('TYPE_DECAY has pattern decay slowest and episodic fastest', () => {
  assert.ok(TYPE_DECAY.pattern.perSession < TYPE_DECAY.episodic.perSession);
  assert.equal(TYPE_DECAY.episodic.ageOutDays, 90);
  assert.equal(TYPE_DECAY.pattern.ageOutDays, 180);
  assert.equal(TYPE_DECAY.semantic.ageOutDays, Infinity);
  assert.equal(TYPE_DECAY.procedural.ageOutDays, Infinity);
});

test('TYPE_BOOST_ON_INJECT favours pattern', () => {
  assert.ok(TYPE_BOOST_ON_INJECT.pattern > TYPE_BOOST_ON_INJECT.episodic);
});

test('TYPE_BOOST_ON_ACCESS favours pattern', () => {
  assert.ok(TYPE_BOOST_ON_ACCESS.pattern > TYPE_BOOST_ON_ACCESS.episodic);
});

test('RELATION_WEIGHT constants have expected values', () => {
  assert.equal(RELATION_WEIGHT.strongThreshold, 0.5);
  assert.equal(RELATION_WEIGHT.floor, 0.05);
  assert.equal(RELATION_WEIGHT.coActivationPromotionCount, 3);
  assert.equal(RELATION_WEIGHT.decayPerSession, 0.005);
});

test('computeInitialRelationWeight returns per-rule initial weights', () => {
  assert.equal(computeInitialRelationWeight('contradicts', { cosineDistance: 0.1 }), 0.9);
  assert.equal(computeInitialRelationWeight('extends', { similarity: 0.25 }), 0.25);
  assert.equal(computeInitialRelationWeight('relates_to', { sharedTagCount: 2 }), 0.5);
  assert.equal(computeInitialRelationWeight('relates_to', { sharedTagCount: 5 }), 0.8); // caps at 0.8
  assert.equal(computeInitialRelationWeight('relates_to', { sharedTagCount: 10 }), 0.8);
  assert.equal(computeInitialRelationWeight('derived_from', {}), 0.5);
  assert.equal(computeInitialRelationWeight('co_activation', {}), 0.45);
});
