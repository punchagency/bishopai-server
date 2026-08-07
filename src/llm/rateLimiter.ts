import { llmConfig } from './config';

// Global token-bucket limiter for LLM calls.
//
// A provider's per-minute token budget (Groq's free tier: ~12k TPM, counting
// requested completion tokens) is a hard ceiling the extraction fan-out blows
// past in bursts — the three stages each re-send the full transcript and fire at
// once, and a long session adds chunk calls on top. Left alone, every call over
// the budget 429s and backs off, so the work still lands but slowly and noisily.
//
// This paces admission instead: a call waits in a FIFO queue until the bucket has
// refilled enough for its estimated cost, then goes out under the budget. It is a
// near-no-op when the budget is set high (paid tiers, or a bigger-limit provider).

interface Waiter {
  cost: number;
  resolve: () => void;
}

export interface TokenLimiter {
  /** Resolve once `cost` tokens of budget are available, consuming them. */
  acquire(cost: number): Promise<void>;
}

export function createTokenLimiter(tokensPerMinute: number): TokenLimiter {
  const capacity = Math.max(1, tokensPerMinute);
  const refillPerMs = capacity / 60_000;
  let available = capacity;
  let last = Date.now();
  const waiters: Waiter[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function refill(): void {
    const now = Date.now();
    available = Math.min(capacity, available + (now - last) * refillPerMs);
    last = now;
  }

  function pump(): void {
    refill();
    while (waiters.length > 0 && waiters[0].cost <= available) {
      const w = waiters.shift()!;
      available -= w.cost;
      w.resolve();
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (waiters.length > 0) {
      // Wake up when the head of the queue can next be served.
      const deficit = waiters[0].cost - available;
      const waitMs = Math.max(50, Math.ceil(deficit / refillPerMs));
      timer = setTimeout(pump, waitMs);
      timer.unref?.(); // never keep the process alive on the limiter alone
    }
  }

  return {
    acquire(cost: number): Promise<void> {
      // A single call larger than the whole bucket could never be served; clamp
      // it so it waits at most one window rather than forever.
      const clamped = Math.max(1, Math.min(Math.ceil(cost), capacity));
      return new Promise((resolve) => {
        waiters.push({ cost: clamped, resolve });
        pump();
      });
    },
  };
}

/** The process-wide limiter, sized to the active provider's budget. */
export const llmLimiter = createTokenLimiter(llmConfig.tokensPerMinute);
