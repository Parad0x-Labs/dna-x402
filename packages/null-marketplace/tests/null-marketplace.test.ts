/**
 * Tests for @parad0x_labs/null-marketplace
 * Run: npm test   (jest + ts-jest)
 */

import {
  buildTaskListing,
  buildBid,
  acceptBid,
  submitDeliverable,
  releasePayment,
  estimateBounty,
  TaskListing,
  TaskComplexity,
} from '../src/index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function newTask(over: Partial<Parameters<typeof buildTaskListing>[0]> = {}): TaskListing {
  return buildTaskListing({
    title: 'Summarise 10 papers',
    description: 'Produce a 1-page summary per paper',
    requiredCapabilities: ['research'],
    bountyNull: 50,
    deadline: 1_900_000_000,
    posterAddress: 'poster.null',
    ...over,
  });
}

describe('buildTaskListing', () => {
  it('creates an open task carrying every supplied field', () => {
    const t = newTask({ bountyUsdc: 5, attachmentHash: 'arTx123' });
    expect(t.taskId).toMatch(UUID_V4);
    expect(t).toEqual({
      taskId: t.taskId,
      title: 'Summarise 10 papers',
      description: 'Produce a 1-page summary per paper',
      requiredCapabilities: ['research'],
      bountyNull: 50,
      bountyUsdc: 5,
      deadline: 1_900_000_000,
      posterAddress: 'poster.null',
      attachmentHash: 'arTx123',
      status: 'open',
    });
  });

  it('leaves optional USDC bounty and attachment undefined when omitted', () => {
    const t = newTask();
    expect(t.bountyUsdc).toBeUndefined();
    expect(t.attachmentHash).toBeUndefined();
  });

  it('assigns a unique taskId to every listing', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTask().taskId));
    expect(ids.size).toBe(100);
  });
});

describe('buildBid', () => {
  it('builds a bid with defaults for estimatedTime and no prior proof', () => {
    const b = buildBid('task-1', 'bidder.null', 'I will do it', 40);
    expect(b.bidId).toMatch(UUID_V4);
    expect(b).toEqual({
      bidId: b.bidId,
      taskId: 'task-1',
      bidderAddress: 'bidder.null',
      proposedApproach: 'I will do it',
      estimatedTime: 30,
      creditsRequested: 40,
      workProofHash: undefined,
    });
  });

  it('honours estimatedTime and workProofHash options', () => {
    const b = buildBid('task-1', 'bidder.null', 'x', 1, { estimatedTime: 90, workProofHash: 'wp1' });
    expect(b.estimatedTime).toBe(90);
    expect(b.workProofHash).toBe('wp1');
  });

  it('caps the approach at 280 characters', () => {
    expect(buildBid('t', 'b', 'a'.repeat(280), 1).proposedApproach).toHaveLength(280);
    expect(buildBid('t', 'b', 'a'.repeat(281), 1).proposedApproach).toBe('a'.repeat(280));
    expect(buildBid('t', 'b', 'a'.repeat(5000), 1).proposedApproach).toHaveLength(280);
    expect(buildBid('t', 'b', '', 1).proposedApproach).toBe('');
  });

  it('never splits a surrogate pair at the 280-character boundary', () => {
    // 279 ASCII chars + an emoji (2 UTF-16 code units) straddles the cap.
    const approach = 'a'.repeat(279) + '\u{1F680}' + 'tail';
    const out = buildBid('t', 'b', approach, 1).proposedApproach;
    expect(out.length).toBeLessThanOrEqual(280);
    // A lone high surrogate makes the string ill-formed (breaks JSON/UTF-8 encoders).
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    expect(out).toBe('a'.repeat(279));
  });

  it('keeps an emoji that fits entirely inside the cap', () => {
    const approach = 'a'.repeat(278) + '\u{1F680}' + 'tail';
    expect(buildBid('t', 'b', approach, 1).proposedApproach).toBe('a'.repeat(278) + '\u{1F680}');
  });
});

describe('acceptBid', () => {
  it('assigns an open task to the bidder and derives an escrow reference', () => {
    const task = newTask();
    const bid = buildBid(task.taskId, 'bidder.null', 'plan', 45);
    const before = Math.floor(Date.now() / 1000);
    const { assignment, escrowHash } = acceptBid(task, bid);

    expect(task.status).toBe('assigned');
    expect(assignment.taskId).toBe(task.taskId);
    expect(assignment.bidId).toBe(bid.bidId);
    expect(assignment.bidderAddress).toBe('bidder.null');
    expect(assignment.escrowHash).toBe(escrowHash);
    expect(escrowHash).toBe(`escrow_${task.taskId.slice(0, 8)}_${bid.bidId.slice(0, 8)}`);
    expect(assignment.assignedAt).toBeGreaterThanOrEqual(before);
    expect(assignment.assignedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('rejects a bid that references a different task, leaving the task open', () => {
    const task = newTask();
    const other = newTask();
    const bid = buildBid(other.taskId, 'bidder.null', 'plan', 45);
    expect(() => acceptBid(task, bid)).toThrow(/does not reference task/);
    expect(task.status).toBe('open');
  });

  it('rejects accepting a second bid once the task is assigned (no double assignment)', () => {
    const task = newTask();
    acceptBid(task, buildBid(task.taskId, 'first.null', 'plan', 45));
    const second = buildBid(task.taskId, 'second.null', 'plan', 10);
    expect(() => acceptBid(task, second)).toThrow(/is not open \(current status: assigned\)/);
  });

  it.each(['assigned', 'completed', 'paid'] as const)('rejects a task in status %s', (status) => {
    const task = { ...newTask(), status };
    const bid = buildBid(task.taskId, 'b', 'p', 1);
    expect(() => acceptBid(task, bid)).toThrow(/is not open/);
  });
});

describe('submitDeliverable', () => {
  it('records the Arweave tx and work-proof hash with a unix-seconds timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const { receipt } = submitDeliverable('task-9', 'arweaveTx', 'wpHash');
    expect(receipt.taskId).toBe('task-9');
    expect(receipt.resultArweaveTx).toBe('arweaveTx');
    expect(receipt.workProofHash).toBe('wpHash');
    expect(receipt.submittedAt).toBeGreaterThanOrEqual(before);
    expect(receipt.submittedAt).toBeLessThan(10_000_000_000); // seconds, not ms
  });
});

describe('releasePayment', () => {
  function assignedTask(over = {}) {
    const task = newTask(over);
    const bid = buildBid(task.taskId, 'bidder.null', 'plan', 45);
    acceptBid(task, bid);
    return task;
  }

  it('pays an assigned task and produces a WorkProof from the deliverable', () => {
    const task = assignedTask({ bountyNull: 200, bountyUsdc: 20 });
    const { receipt } = submitDeliverable(task.taskId, 'arTxResult', 'abcdef0123456789');
    const { paymentTx, workProof } = releasePayment(task, receipt);

    expect(task.status).toBe('paid');
    expect(paymentTx).toBe(`paytx_${task.taskId.slice(0, 8)}_abcdef01_${workProof.completedAt}`);
    expect(workProof).toEqual({
      version: 1,
      taskId: task.taskId,
      bidderAddress: '',
      resultArweaveTx: 'arTxResult',
      workProofHash: 'abcdef0123456789',
      completedAt: workProof.completedAt,
      bountyNull: 200,
      bountyUsdc: 20,
      solanaAnchorSlot: workProof.solanaAnchorSlot,
    });
    const slotFromClock = Math.floor((Math.floor(Date.now() / 1000) - 1609459200) * 2);
    expect(Math.abs(workProof.solanaAnchorSlot - slotFromClock)).toBeLessThanOrEqual(4);
  });

  it('defaults the USDC bounty to 0 when none was offered', () => {
    const task = assignedTask();
    const { receipt } = submitDeliverable(task.taskId, 'ar', 'wp');
    expect(releasePayment(task, receipt).workProof.bountyUsdc).toBe(0);
  });

  it('accepts a task in completed status', () => {
    const task = { ...newTask(), status: 'completed' as const };
    const { receipt } = submitDeliverable(task.taskId, 'ar', 'wp');
    expect(() => releasePayment(task, receipt)).not.toThrow();
    expect(task.status).toBe('paid');
  });

  it('refuses to pay an open (never assigned) task', () => {
    const task = newTask();
    const { receipt } = submitDeliverable(task.taskId, 'ar', 'wp');
    expect(() => releasePayment(task, receipt)).toThrow(/must be assigned or completed.*current: open/);
    expect(task.status).toBe('open');
  });

  it('refuses a second release for the same task (replay)', () => {
    const task = assignedTask();
    const { receipt } = submitDeliverable(task.taskId, 'ar', 'wp');
    releasePayment(task, receipt);
    expect(() => releasePayment(task, receipt)).toThrow(/current: paid/);
  });

  it('refuses a deliverable submitted for another task and leaves the task assigned', () => {
    const task = assignedTask();
    const { receipt } = submitDeliverable('some-other-task', 'ar', 'wp');
    expect(() => releasePayment(task, receipt)).toThrow(/taskId mismatch/);
    expect(task.status).toBe('assigned');
  });
});

describe('estimateBounty', () => {
  it.each<[TaskComplexity, number, number, number]>([
    ['simple', 10, 0.5, 5],
    ['medium', 50, 5, 30],
    ['complex', 200, 20, 120],
    ['expert', 1000, 100, 1440],
  ])('%s tier → %d NULL / %d USDC / %d min', (tier, n, u, m) => {
    expect(estimateBounty(tier)).toEqual({ suggestedNull: n, suggestedUsdc: u, estimatedMinutes: m });
  });

  it('tiers are strictly increasing in every dimension', () => {
    const tiers: TaskComplexity[] = ['simple', 'medium', 'complex', 'expert'];
    const est = tiers.map(estimateBounty);
    for (let i = 1; i < est.length; i++) {
      expect(est[i].suggestedNull).toBeGreaterThan(est[i - 1].suggestedNull);
      expect(est[i].suggestedUsdc).toBeGreaterThan(est[i - 1].suggestedUsdc);
      expect(est[i].estimatedMinutes).toBeGreaterThan(est[i - 1].estimatedMinutes);
    }
  });

  it('returns a copy: mutating the result does not change later estimates', () => {
    const e = estimateBounty('medium');
    e.suggestedNull = 1;
    expect(estimateBounty('medium').suggestedNull).toBe(50);
  });

  it('rejects an unknown complexity instead of returning an empty estimate', () => {
    expect(() => estimateBounty('legendary' as TaskComplexity)).toThrow(/Unknown task complexity/);
    expect(() => estimateBounty('toString' as TaskComplexity)).toThrow(/Unknown task complexity/);
  });
});

describe('full task lifecycle', () => {
  it('open → assigned → deliverable → paid', () => {
    const est = estimateBounty('complex');
    const task = newTask({ bountyNull: est.suggestedNull, bountyUsdc: est.suggestedUsdc });
    const bids = [
      buildBid(task.taskId, 'cheap.null', 'fast', 100, { estimatedTime: 60 }),
      buildBid(task.taskId, 'good.null', 'thorough', 180, { estimatedTime: 120 }),
    ];
    const { assignment } = acceptBid(task, bids[1]);
    expect(assignment.bidderAddress).toBe('good.null');
    expect(() => acceptBid(task, bids[0])).toThrow();

    const { receipt } = submitDeliverable(task.taskId, 'arResult', 'proofhash123');
    const { workProof } = releasePayment(task, receipt);
    expect(task.status).toBe('paid');
    expect(workProof.bountyNull).toBe(200);
    expect(workProof.bountyUsdc).toBe(20);
  });
});
