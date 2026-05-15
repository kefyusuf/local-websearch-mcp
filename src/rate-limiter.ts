export interface TokenBucketConfig {
  maxTokens: number;
  refillRatePerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly config: TokenBucketConfig;

  constructor(config: TokenBucketConfig) {
    this.config = config;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const toAdd = elapsed * this.config.refillRatePerSecond;
    this.tokens = Math.min(this.config.maxTokens, this.tokens + toAdd);
    this.lastRefill = now;
  }

  tryConsume(count: number = 1): { allowed: boolean; retryAfterMs: number } {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return { allowed: true, retryAfterMs: 0 };
    }
    const tokensNeeded = count - this.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded / this.config.refillRatePerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }

  getStats(): { available: number; max: number } {
    this.refill();
    return { available: Math.floor(this.tokens), max: this.config.maxTokens };
  }
}

export function createSearchRateLimiter(): TokenBucket {
  const perMinute = parseInt(process.env.RATE_LIMIT_SEARCH_PER_MIN || "10", 10);
  return new TokenBucket({
    maxTokens: Math.min(perMinute, 5),
    refillRatePerSecond: perMinute / 60,
  });
}

export function createFetchRateLimiter(): TokenBucket {
  const perMinute = parseInt(process.env.RATE_LIMIT_FETCH_PER_MIN || "20", 10);
  return new TokenBucket({
    maxTokens: Math.min(perMinute, 5),
    refillRatePerSecond: perMinute / 60,
  });
}
