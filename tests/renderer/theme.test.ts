import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BASIC_PREFERENCES } from "../../src/renderer/src/ui/preferences";

const BASIC_PREFERENCES_STORAGE_KEY = "agent-pyramid.basicPreferences";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

describe("renderer theme helpers", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("updates the active theme when the system color scheme changes", async () => {
    const mediaQuery = createTestMediaQueryList(false);
    setupThemeDom(mediaQuery, {
      ...DEFAULT_BASIC_PREFERENCES,
      followSystemTheme: true,
    });
    const { initTheme } = await import("../../src/renderer/src/i18n");

    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(mediaQuery.listenerCount()).toBe(1);

    mediaQuery.setMatches(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("stops following system changes after a manual theme selection", async () => {
    const mediaQuery = createTestMediaQueryList(false);
    setupThemeDom(mediaQuery, {
      ...DEFAULT_BASIC_PREFERENCES,
      followSystemTheme: true,
    });
    const { initTheme, setTheme } = await import("../../src/renderer/src/i18n");

    initTheme();
    setTheme("light");
    expect(mediaQuery.listenerCount()).toBe(0);

    mediaQuery.setMatches(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("starts following system changes when the setting is enabled at runtime", async () => {
    const mediaQuery = createTestMediaQueryList(true);
    setupThemeDom(mediaQuery, {
      ...DEFAULT_BASIC_PREFERENCES,
      theme: "light",
      followSystemTheme: false,
    });
    const { initTheme, setFollowSystemTheme } =
      await import("../../src/renderer/src/i18n");

    initTheme();
    expect(document.documentElement.dataset.theme).toBe("light");

    setFollowSystemTheme(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mediaQuery.listenerCount()).toBe(1);

    mediaQuery.setMatches(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

function setupThemeDom(
  mediaQuery: TestMediaQueryList,
  preferences: typeof DEFAULT_BASIC_PREFERENCES,
): void {
  const localStorage = createMemoryStorage();
  localStorage.setItem(BASIC_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  vi.stubGlobal("window", {
    localStorage,
    matchMedia: (query: string) => {
      if (query !== SYSTEM_THEME_QUERY) {
        throw new Error(`Unexpected media query: ${query}`);
      }
      return mediaQuery;
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      dataset: {},
    },
  });
  vi.stubGlobal("navigator", {
    userAgent: "Vitest",
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

class TestMediaQueryList implements MediaQueryList {
  readonly media = SYSTEM_THEME_QUERY;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null = null;
  matches: boolean;
  private readonly eventListeners = new Set<EventListenerOrEventListenerObject>();
  private readonly legacyListeners = new Set<
    (this: MediaQueryList, ev: MediaQueryListEvent) => void
  >();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === "change" && callback) {
      this.eventListeners.add(callback);
    }
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (type === "change" && callback) {
      this.eventListeners.delete(callback);
    }
  }

  addListener(
    callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null,
  ): void {
    if (callback) {
      this.legacyListeners.add(callback);
    }
  }

  removeListener(
    callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null,
  ): void {
    if (callback) {
      this.legacyListeners.delete(callback);
    }
  }

  dispatchEvent(event: Event): boolean {
    this.notify(event as MediaQueryListEvent);
    return true;
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    this.notify(createMediaQueryListEvent(this));
  }

  listenerCount(): number {
    return this.eventListeners.size + this.legacyListeners.size;
  }

  private notify(event: MediaQueryListEvent): void {
    this.onchange?.call(this, event);
    for (const listener of this.eventListeners) {
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
    for (const listener of this.legacyListeners) {
      listener.call(this, event);
    }
  }
}

function createTestMediaQueryList(matches: boolean): TestMediaQueryList {
  return new TestMediaQueryList(matches);
}

function createMediaQueryListEvent(
  mediaQuery: MediaQueryList,
): MediaQueryListEvent {
  return {
    type: "change",
    matches: mediaQuery.matches,
    media: mediaQuery.media,
  } as MediaQueryListEvent;
}
