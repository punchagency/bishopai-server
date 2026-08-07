import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTokenLimiter } from './rateLimiter';

// Fake timers make the token-bucket deterministic: vitest also mocks Date.now,
// so the bucket's refill math advances exactly with advanceTimersByTimeAsync.
describe('createTokenLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits calls immediately while budget remains, then queues', async () => {
    vi.useFakeTimers();
    const lim = createTokenLimiter(60_000); // 60k tokens / minute = 1k / ms of headroom

    let firstDone = false;
    let secondDone = false;
    void lim.acquire(60_000).then(() => (firstDone = true)); // drains the whole bucket
    void lim.acquire(60_000).then(() => (secondDone = true)); // must wait for a refill

    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);

    // A little refill isn't enough for the full-cost waiter.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(secondDone).toBe(false);

    // One full window refills the bucket; the queued call is admitted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(secondDone).toBe(true);
  });

  it('serves queued calls in FIFO order', async () => {
    vi.useFakeTimers();
    const lim = createTokenLimiter(1_000);
    const order: number[] = [];
    void lim.acquire(1_000).then(() => order.push(1)); // drains bucket
    void lim.acquire(1_000).then(() => order.push(2));
    void lim.acquire(1_000).then(() => order.push(3));

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(60_000); // refill one window → next waiter
    expect(order).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not deadlock on a single call larger than the whole bucket', async () => {
    vi.useFakeTimers();
    const lim = createTokenLimiter(1_000);
    let done = false;
    void lim.acquire(10_000).then(() => (done = true)); // clamped to capacity
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true); // full bucket satisfies the clamped cost immediately
  });
});
