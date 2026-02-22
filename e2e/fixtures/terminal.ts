import { type Page, expect } from "@playwright/test";

/**
 * Add a terminal block to the current dashboard canvas.
 * Clicks the toolbar button identified by data-guidance-target.
 */
export async function addTerminal(
  page: Page,
  type: "terminal" | "claude-code" | "gemini-cli" | "codex" = "terminal"
): Promise<void> {
  const button = page.locator(`[data-guidance-target="${type}"]`);
  await button.click();

  // Wait for xterm to appear on the canvas
  await page.locator(".xterm").first().waitFor({ timeout: 30_000 });
}

/**
 * Read terminal text content from xterm DOM.
 *
 * xterm v5 uses canvas rendering by default but still maintains a DOM
 * layer underneath (.xterm-rows) with span elements containing text.
 * Falls back to other selectors if .xterm-rows is not available.
 */
async function readTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Approach 1: .xterm-rows (xterm v4/v5 DOM layer)
    const rows = document.querySelector(".xterm-rows");
    if (rows) {
      // Get text from each row div individually for cleaner extraction
      const rowDivs = rows.querySelectorAll(":scope > div");
      if (rowDivs.length > 0) {
        return Array.from(rowDivs)
          .map((r) => r.textContent || "")
          .join("\n");
      }
      // Fallback: entire textContent
      if (rows.textContent?.trim()) return rows.textContent;
    }

    // Approach 2: xterm accessibility tree (xterm v5+)
    const accessTree = document.querySelector(".xterm-accessibility-tree");
    if (accessTree?.textContent?.trim()) return accessTree.textContent;

    // Approach 3: any .xterm text
    const xterm = document.querySelector(".xterm");
    return xterm?.textContent || "";
  });
}

/**
 * Wait for the terminal to connect and show a shell prompt.
 * The sandbox needs to boot (Fly machine start), create a session,
 * and establish a WebSocket connection before the prompt appears.
 */
export async function waitForPrompt(
  page: Page,
  timeoutMs = 90_000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const content = await readTerminalText(page);

    // A connected terminal will have some content — a prompt character
    // like $, #, >, or a username/path in the prompt
    if (content && content.trim().length > 0) {
      return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `Terminal did not show a prompt within ${timeoutMs}ms. ` +
      "Check that the sandbox boots and the WebSocket connects."
  );
}

/**
 * Type a command into the terminal and press Enter.
 * Clicks the terminal first to ensure it has focus.
 */
export async function typeCommand(
  page: Page,
  command: string
): Promise<void> {
  // Click the xterm viewport area to focus the terminal
  // The xterm helper textarea receives keyboard input
  const xtermScreen = page.locator(".xterm-screen").first();
  await xtermScreen.click();

  // Small delay to ensure focus is established
  await page.waitForTimeout(300);

  // Type the command (character by character to trigger key handlers)
  await page.keyboard.type(command, { delay: 50 });
  await page.keyboard.press("Enter");
}

/**
 * Wait for specific text to appear in terminal output.
 * Polls the xterm DOM text content using multiple extraction strategies.
 */
export async function waitForOutput(
  page: Page,
  text: string | RegExp,
  timeoutMs = 30_000
): Promise<void> {
  const startTime = Date.now();
  let lastContent = "";
  while (Date.now() - startTime < timeoutMs) {
    const content = await readTerminalText(page);
    lastContent = content;

    if (content) {
      if (typeof text === "string" && content.includes(text)) return;
      if (text instanceof RegExp && text.test(content)) return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out waiting for terminal output matching: ${text}\n` +
      `Last terminal content (first 500 chars): ${lastContent.substring(0, 500)}`
  );
}
