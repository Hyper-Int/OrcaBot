// REVISION: e2e-diagnostics-v3-narrow-expected-errors
import type { ConsoleMessage, Page, Request, TestInfo } from "@playwright/test";

const MODULE_REVISION = "e2e-diagnostics-v3-narrow-expected-errors";
console.log(
  `[e2e-diagnostics] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

type DiagnosticLevel = "log" | "warning" | "error";

interface PerfEntry {
  name?: string;
  entryType?: string;
  startTime?: number;
  duration?: number;
  value?: number;
  hadRecentInput?: boolean;
}

interface PerformanceSummary {
  longTaskCount: number;
  longTaskMaxMs: number;
  cumulativeLayoutShift: number;
  resourceCount: number;
  slowResources: Array<{ name: string; duration: number }>;
  navigation?: Record<string, number>;
}

export interface DiagnosticsSnapshot {
  revision: string;
  collectedAt: string;
  url: string;
  console: Array<{ type: string; text: string; location?: string }>;
  pageErrors: string[];
  requestFailures: Array<{ url: string; method: string; failure: string | null }>;
  performance: PerformanceSummary;
  heuristics: {
    consoleErrors: number;
    pageErrors: number;
    requestFailures: number;
    longTaskMaxMs: number;
    cumulativeLayoutShift: number;
  };
}

export interface E2EDiagnostics {
  snapshot: () => Promise<DiagnosticsSnapshot>;
  attach: (testInfo: TestInfo) => Promise<void>;
  assertNoSevereIssues: (options?: { ignore?: RegExp[] }) => Promise<void>;
}

interface ExpectedConsoleError {
  /** Why this specific response is expected, not a defect. */
  why: string;
  /** Matched against the console message text (carries the status code). */
  text: RegExp;
  /** Matched against the message location URL, when the case is endpoint-specific. */
  url?: RegExp;
}

/**
 * The narrow set of console errors that are browser-generated noise rather than
 * app defects.
 *
 * Chromium emits "Failed to load resource: ... <status>" for EVERY non-2xx
 * response, so a couple of responses the app deliberately provokes and handles
 * would otherwise fail every test that logs in.
 *
 * Deliberately enumerated case by case, scoped by endpoint wherever the status
 * alone is ambiguous. A blanket 4xx filter would swallow real breakage — 400
 * (bad request), 409 (conflict), 422 (validation), 429 (rate limited) are all
 * genuine failures worth failing a test over, as is anything 5xx.
 *
 * Everything is still captured in the attached diagnostics.json regardless; this
 * only affects the pass/fail decision. Uncaught exceptions (pageErrors) and
 * genuine console.error calls from app code are never filtered.
 */
const EXPECTED_CONSOLE_ERRORS: ExpectedConsoleError[] = [
  {
    why:
      "The login helpers load authenticated routes while logged out on purpose " +
      "(isAlreadyAuthenticated opens /dashboards before any login), so the app's " +
      "auth checks correctly answer 401/403.",
    text: /the server responded with a status of 40[13]\b/i,
  },
  {
    why:
      "A dashboard with no cached workspace snapshot answers 404; " +
      "getWorkspaceSnapshot() documents that as expected and returns null.",
    text: /the server responded with a status of 404\b/i,
    url: /\/dashboards\/[^/]+\/workspace-snapshot\b/,
  },
];

/** True when a console error is one of the documented expected responses. */
function isExpectedConsoleError(message: {
  text: string;
  location?: string;
}): boolean {
  return EXPECTED_CONSOLE_ERRORS.some(
    (expected) =>
      expected.text.test(message.text) &&
      (!expected.url || expected.url.test(message.location ?? ""))
  );
}

declare global {
  interface Window {
    __orcabotE2EPerf?: {
      longTasks: PerfEntry[];
      layoutShifts: PerfEntry[];
      resources: PerfEntry[];
    };
  }
}

function formatConsoleLocation(msg: ConsoleMessage): string | undefined {
  const location = msg.location();
  if (!location.url) return undefined;
  return `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`;
}

function classifyConsoleType(type: string): DiagnosticLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warning";
  return "log";
}

async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__orcabotE2EPerf = {
      longTasks: [],
      layoutShifts: [],
      resources: [],
    };

    const store = window.__orcabotE2EPerf;
    if (!store) return;

    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.longTasks.push({
            name: entry.name,
            entryType: entry.entryType,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch {}

    try {
      const layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layoutShift = entry as PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
          };
          store.layoutShifts.push({
            name: entry.name,
            entryType: entry.entryType,
            startTime: entry.startTime,
            duration: entry.duration,
            value: layoutShift.value,
            hadRecentInput: layoutShift.hadRecentInput,
          });
        }
      });
      layoutShiftObserver.observe({ type: "layout-shift", buffered: true });
    } catch {}

    try {
      const resourceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.resources.push({
            name: entry.name,
            entryType: entry.entryType,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      resourceObserver.observe({ type: "resource", buffered: true });
    } catch {}
  });
}

function summarizePerformance(
  perfData: Window["__orcabotE2EPerf"] | null,
  navigationTiming: Record<string, number> | undefined
): PerformanceSummary {
  const longTasks = perfData?.longTasks ?? [];
  const layoutShifts = perfData?.layoutShifts ?? [];
  const resources = perfData?.resources ?? [];
  const slowResources = resources
    .filter((entry) => (entry.duration ?? 0) >= 1_000 && entry.name)
    .slice(0, 10)
    .map((entry) => ({
      name: entry.name || "unknown",
      duration: Math.round(entry.duration || 0),
    }));

  return {
    longTaskCount: longTasks.length,
    longTaskMaxMs: Math.round(
      longTasks.reduce((max, entry) => Math.max(max, entry.duration || 0), 0)
    ),
    cumulativeLayoutShift: Number(
      layoutShifts
        .filter((entry) => !entry.hadRecentInput)
        .reduce((sum, entry) => sum + (entry.value || 0), 0)
        .toFixed(4)
    ),
    resourceCount: resources.length,
    slowResources,
    navigation: navigationTiming,
  };
}

export async function createDiagnostics(page: Page): Promise<E2EDiagnostics> {
  const consoleMessages: DiagnosticsSnapshot["console"] = [];
  const pageErrors: string[] = [];
  const requestFailures: DiagnosticsSnapshot["requestFailures"] = [];

  await installPerformanceObservers(page);

  page.on("console", (msg) => {
    const level = classifyConsoleType(msg.type());
    if (level === "log") return;
    consoleMessages.push({
      type: msg.type(),
      text: msg.text(),
      location: formatConsoleLocation(msg),
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("requestfailed", (request: Request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText ?? null,
    });
  });

  async function snapshot(): Promise<DiagnosticsSnapshot> {
    const [perfData, navigationTiming] = await Promise.all([
      page
        .evaluate(() => window.__orcabotE2EPerf || null)
        .catch(() => null),
      page
        .evaluate(() => {
          const entry = performance.getEntriesByType(
            "navigation"
          )[0] as PerformanceNavigationTiming | undefined;
          if (!entry) return undefined;
          return {
            domContentLoaded: Math.round(
              entry.domContentLoadedEventEnd - entry.startTime
            ),
            loadEvent: Math.round(entry.loadEventEnd - entry.startTime),
            responseStart: Math.round(entry.responseStart - entry.startTime),
          };
        })
        .catch(() => undefined),
    ]);

    // Deliberately NOT named `performance`: that shadows the global inside the
    // page.evaluate callbacks above, so `performance.getEntriesByType` would
    // resolve to this summary object instead of the browser's Performance API.
    const perfSummary = summarizePerformance(perfData, navigationTiming);

    return {
      revision: MODULE_REVISION,
      collectedAt: new Date().toISOString(),
      url: page.url(),
      console: [...consoleMessages],
      pageErrors: [...pageErrors],
      requestFailures: [...requestFailures],
      performance: perfSummary,
      heuristics: {
        consoleErrors: consoleMessages.filter(
          (message) => classifyConsoleType(message.type) === "error"
        ).length,
        pageErrors: pageErrors.length,
        requestFailures: requestFailures.length,
        longTaskMaxMs: perfSummary.longTaskMaxMs,
        cumulativeLayoutShift: perfSummary.cumulativeLayoutShift,
      },
    };
  }

  async function attach(testInfo: TestInfo): Promise<void> {
    const data = await snapshot();
    await testInfo.attach("diagnostics.json", {
      body: JSON.stringify(data, null, 2),
      contentType: "application/json",
    });
  }

  async function assertNoSevereIssues(
    options: { ignore?: RegExp[] } = {}
  ): Promise<void> {
    const data = await snapshot();
    if (data.pageErrors.length > 0) {
      throw new Error(
        `Detected page errors:\n${data.pageErrors.map((msg) => `- ${msg}`).join("\n")}`
      );
    }

    const extraIgnores = options.ignore ?? [];
    const errors = data.console
      .filter((message) => classifyConsoleType(message.type) === "error")
      .filter((message) => !isExpectedConsoleError(message))
      .filter((message) => !extraIgnores.some((pattern) => pattern.test(message.text)))
      .map((message) =>
        message.location ? `- ${message.text} (${message.location})` : `- ${message.text}`
      );

    if (errors.length > 0) {
      throw new Error(`Detected console errors:\n${errors.join("\n")}`);
    }
  }

  return { snapshot, attach, assertNoSevereIssues };
}
