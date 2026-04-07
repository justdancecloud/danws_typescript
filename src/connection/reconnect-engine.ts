export interface ReconnectOptions {
  enabled: boolean;
  maxRetries: number;       // 0 = unlimited
  baseDelay: number;        // ms
  maxDelay: number;         // ms
  backoffMultiplier: number;
  jitter: boolean;
  offlineQueueSize: number;
}

export const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  enabled: true,
  maxRetries: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
  offlineQueueSize: 1000,
};

export class ReconnectEngine {
  private _attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _active = false;
  private readonly options: ReconnectOptions;

  private _onReconnect: ((attempt: number, delay: number) => void) | null = null;
  private _onExhausted: (() => void) | null = null;
  private _onAttempt: (() => void) | null = null;

  constructor(options?: Partial<ReconnectOptions>) {
    this.options = { ...DEFAULT_RECONNECT_OPTIONS, ...options };
  }

  onReconnect(callback: (attempt: number, delay: number) => void): void {
    this._onReconnect = callback;
  }

  onExhausted(callback: () => void): void {
    this._onExhausted = callback;
  }

  /** Called when the timer fires — the caller should attempt to reconnect. */
  onAttempt(callback: () => void): void {
    this._onAttempt = callback;
  }

  get attempt(): number {
    return this._attempt;
  }

  get isActive(): boolean {
    return this._active;
  }

  /**
   * Start the reconnection cycle.
   * Calls onReconnect with (attempt, delay) before each attempt.
   */
  start(): void {
    if (!this.options.enabled || this._active) return;

    this._active = true;
    this._attempt = 0;
    this.scheduleNext();
  }

  /**
   * Stop the reconnection cycle (e.g., on successful connect or intentional disconnect).
   */
  stop(): void {
    this._active = false;
    this._attempt = 0;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Calculate delay for a given attempt (1-indexed).
   */
  calculateDelay(attempt: number): number {
    const raw = this.options.baseDelay * Math.pow(this.options.backoffMultiplier, attempt - 1);
    const capped = Math.min(raw, this.options.maxDelay);

    if (this.options.jitter) {
      // jitter: delay × random(0.5 ~ 1.5)
      return capped * (0.5 + Math.random());
    }
    return capped;
  }

  private scheduleNext(): void {
    this._attempt++;

    if (this.options.maxRetries > 0 && this._attempt > this.options.maxRetries) {
      this._active = false;
      if (this._onExhausted) this._onExhausted();
      return;
    }

    const delay = this.calculateDelay(this._attempt);

    if (this._onReconnect) {
      this._onReconnect(this._attempt, delay);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this._onAttempt) this._onAttempt();
    }, delay);
  }

  /**
   * Called when a reconnect attempt fails. Schedules the next attempt.
   */
  retry(): void {
    if (this._active) {
      this.scheduleNext();
    }
  }

  dispose(): void {
    this.stop();
    this._onReconnect = null;
    this._onExhausted = null;
    this._onAttempt = null;
  }
}
