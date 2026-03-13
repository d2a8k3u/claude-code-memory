import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocateBudget, CONTEXT_BUDGET } from '../cli/session-start.js';
import { makeMemoryRow } from './helpers.js';

function makeCandidate(id: string, quality: number, type = 'semantic' as const) {
  return {
    memory: makeMemoryRow({ id, type }),
    quality,
  };
}

function makeSection(
  name: 'relevant' | 'episodic' | 'semantic' | 'pattern' | 'procedural',
  candidates: Array<{ memory: ReturnType<typeof makeMemoryRow>; quality: number }>,
) {
  return {
    name,
    heading: `## ${name}`,
    candidates,
    format: (mem: { content: string }, _quality: number) => mem.content,
  };
}

describe('allocateBudget', () => {
  it('respects per-section minimums', () => {
    const sections = [
      makeSection('relevant', [makeCandidate('r1', 0.9), makeCandidate('r2', 0.8)]),
      makeSection('episodic', [makeCandidate('e1', 0.5)]),
      makeSection('semantic', [makeCandidate('s1', 0.7), makeCandidate('s2', 0.6)]),
      makeSection('pattern', [makeCandidate('p1', 0.4)]),
      makeSection('procedural', [makeCandidate('pr1', 0.3)]),
    ];

    const { allocated } = allocateBudget(sections);

    assert.ok((allocated.get('episodic') ?? []).length >= 1, 'episodic should get at least min (1)');
    assert.ok((allocated.get('pattern') ?? []).length >= 1, 'pattern should get at least min (1)');
    assert.ok((allocated.get('procedural') ?? []).length >= 1, 'procedural should get at least min (1)');
  });

  it('distributes overflow to highest-quality candidates', () => {
    const sections = [
      makeSection('relevant', [
        makeCandidate('r1', 0.9),
        makeCandidate('r2', 0.85),
        makeCandidate('r3', 0.8),
        makeCandidate('r4', 0.75),
        makeCandidate('r5', 0.7),
      ]),
      makeSection('episodic', [makeCandidate('e1', 0.3)]),
      makeSection('semantic', [makeCandidate('s1', 0.2)]),
      makeSection('pattern', [makeCandidate('p1', 0.1)]),
      makeSection('procedural', [makeCandidate('pr1', 0.05)]),
    ];

    const { allocated } = allocateBudget(sections);

    // Relevant has the highest quality candidates, so overflow should go there
    assert.ok(
      (allocated.get('relevant') ?? []).length > CONTEXT_BUDGET.relevant.min,
      'relevant should get overflow slots due to high quality',
    );
  });

  it('respects per-section maximums', () => {
    // Create more candidates than max for relevant
    const relevantCandidates = Array.from({ length: 20 }, (_, i) => makeCandidate(`r${i}`, 0.9 - i * 0.01));

    const sections = [
      makeSection('relevant', relevantCandidates),
      makeSection('episodic', [makeCandidate('e1', 0.01)]),
      makeSection('semantic', [makeCandidate('s1', 0.01)]),
      makeSection('pattern', [makeCandidate('p1', 0.01)]),
      makeSection('procedural', [makeCandidate('pr1', 0.01)]),
    ];

    const { allocated } = allocateBudget(sections);

    assert.ok(
      (allocated.get('relevant') ?? []).length <= CONTEXT_BUDGET.relevant.max,
      `relevant should not exceed max (${CONTEXT_BUDGET.relevant.max})`,
    );
  });

  it('does not exceed total budget', () => {
    // All sections have many high-quality candidates
    const makeManyHigh = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => makeCandidate(`${prefix}${i}`, 0.9 - i * 0.01));

    const sections = [
      makeSection('relevant', makeManyHigh('r', 15)),
      makeSection('episodic', makeManyHigh('e', 5)),
      makeSection('semantic', makeManyHigh('s', 8)),
      makeSection('pattern', makeManyHigh('p', 5)),
      makeSection('procedural', makeManyHigh('pr', 5)),
    ];

    const { allocated, seenIds } = allocateBudget(sections);

    let total = 0;
    for (const items of allocated.values()) total += items.length;
    assert.ok(total <= CONTEXT_BUDGET.total, `total ${total} should not exceed budget ${CONTEXT_BUDGET.total}`);
    assert.equal(total, seenIds.size, 'seenIds size should match total allocated');
  });

  it('deduplicates across sections', () => {
    // Same memory ID appears in both relevant and semantic
    const sharedMem = makeMemoryRow({ id: 'shared-1', type: 'semantic' });
    const sections = [
      makeSection('relevant', [{ memory: sharedMem, quality: 0.9 }]),
      makeSection('episodic', [makeCandidate('e1', 0.5)]),
      makeSection('semantic', [{ memory: { ...sharedMem }, quality: 0.8 }]),
      makeSection('pattern', [makeCandidate('p1', 0.4)]),
      makeSection('procedural', [makeCandidate('pr1', 0.3)]),
    ];

    const { allocated, seenIds } = allocateBudget(sections);

    // shared-1 should appear in exactly one section
    let appearances = 0;
    for (const items of allocated.values()) {
      appearances += items.filter((c) => c.memory.id === 'shared-1').length;
    }
    assert.equal(appearances, 1, 'shared memory should appear exactly once');
    assert.ok(seenIds.has('shared-1'));
  });

  it('handles empty sections gracefully', () => {
    const sections = [
      makeSection('relevant', []),
      makeSection('episodic', [makeCandidate('e1', 0.5)]),
      makeSection('semantic', [makeCandidate('s1', 0.7), makeCandidate('s2', 0.6)]),
      makeSection('pattern', []),
      makeSection('procedural', []),
    ];

    const { allocated } = allocateBudget(sections);

    assert.equal((allocated.get('relevant') ?? []).length, 0);
    assert.equal((allocated.get('pattern') ?? []).length, 0);
    assert.ok((allocated.get('episodic') ?? []).length >= 1);
    assert.ok((allocated.get('semantic') ?? []).length >= 1);
  });

  it('gives unused min-budget to other sections', () => {
    // relevant has 0 candidates — its min (3) budget should be available to others
    const sections = [
      makeSection('relevant', []),
      makeSection('episodic', [makeCandidate('e1', 0.5)]),
      makeSection(
        'semantic',
        Array.from({ length: 8 }, (_, i) => makeCandidate(`s${i}`, 0.9 - i * 0.05)),
      ),
      makeSection('pattern', [makeCandidate('p1', 0.4)]),
      makeSection('procedural', [makeCandidate('pr1', 0.3)]),
    ];

    const { allocated } = allocateBudget(sections);

    // Semantic should get more than its min because relevant's budget is unused
    assert.ok(
      (allocated.get('semantic') ?? []).length > CONTEXT_BUDGET.semantic.min,
      'semantic should expand when other sections are empty',
    );
  });

  it('preserves candidate ordering within sections', () => {
    const sections = [
      makeSection('relevant', [makeCandidate('r1', 0.9), makeCandidate('r2', 0.5), makeCandidate('r3', 0.3)]),
      makeSection('episodic', [makeCandidate('e1', 0.1)]),
      makeSection('semantic', [makeCandidate('s1', 0.1)]),
      makeSection('pattern', [makeCandidate('p1', 0.1)]),
      makeSection('procedural', [makeCandidate('pr1', 0.1)]),
    ];

    const { allocated } = allocateBudget(sections);
    const relevantItems = allocated.get('relevant') ?? [];

    for (let i = 1; i < relevantItems.length; i++) {
      assert.ok(
        relevantItems[i - 1].quality >= relevantItems[i].quality,
        'items within a section should maintain quality ordering',
      );
    }
  });
});
