export interface AppLifecycleCleanup {
  name: string;
  run(): Promise<unknown> | unknown;
}

export interface AppLifecycleLogger {
  error(message: string, error: unknown): void;
}

export class AppLifecycle {
  private readonly cleanups: AppLifecycleCleanup[] = [];
  private cleanupPromise: Promise<void> | null = null;

  constructor(private readonly logger: AppLifecycleLogger = console) {}

  registerCleanup(cleanup: AppLifecycleCleanup): void {
    this.cleanups.push(cleanup);
  }

  runCleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.runCleanupOnce();
    return this.cleanupPromise;
  }

  private async runCleanupOnce(): Promise<void> {
    for (const cleanup of this.cleanups) {
      try {
        await cleanup.run();
      } catch (error) {
        this.logger.error(`[main] ${cleanup.name} cleanup failed:`, error);
      }
    }
  }
}
