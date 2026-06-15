export class ProviderHealthTracker {
  history = new Map<string, boolean[]>();
  backoffUntil = new Map<string, number>();

  private static readonly WINDOW = 5;
  private static readonly THRESHOLD = 0.4;
  private static readonly BACKOFF_MS = 2 * 60 * 1000;

  record(name: string, success: boolean): void {
    const attempts = this.history.get(name) ?? [];
    attempts.push(success);

    if (attempts.length > ProviderHealthTracker.WINDOW) {
      attempts.splice(0, attempts.length - ProviderHealthTracker.WINDOW);
    }

    this.history.set(name, attempts);

    if (attempts.length === ProviderHealthTracker.WINDOW) {
      const successCount = attempts.filter(Boolean).length;
      const successRate = successCount / ProviderHealthTracker.WINDOW;
      if (successRate <= ProviderHealthTracker.THRESHOLD) {
        this.backoffUntil.set(name, Date.now() + ProviderHealthTracker.BACKOFF_MS);
      }
    }
  }

  isAvailable(name: string): boolean {
    const until = this.backoffUntil.get(name);
    if (until === undefined) {
      return true;
    }

    if (until > Date.now()) {
      return false;
    }

    this.backoffUntil.delete(name);
    return true;
  }
}
