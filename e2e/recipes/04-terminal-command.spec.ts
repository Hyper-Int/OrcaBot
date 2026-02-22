import { test, expect } from "../fixtures/base";

test.describe("Recipe: Terminal Command Execution", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should run echo and see output", async ({
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Echo-Test");
    await terminal.add();
    await terminal.waitForPrompt();

    // Run a simple echo command
    await terminal.typeCommand("echo 'hello-e2e-test'");

    // Verify the output appears
    await terminal.waitForOutput("hello-e2e-test");
  });

  test("should run pwd and see workspace directory", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Pwd-Test");
    await terminal.add();
    await terminal.waitForPrompt();

    // Extra settle time — sandbox might still be initialising environment
    await page.waitForTimeout(1_000);

    await terminal.typeCommand("pwd");

    // Sandbox workspace is at /home/user or /workspace or /root
    // Use a generous timeout since sandbox might be busy
    await terminal.waitForOutput(/\/(home|workspace|root)/, 45_000);
  });

  test("should run multiple commands sequentially", async ({
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Multi-Cmd");
    await terminal.add();
    await terminal.waitForPrompt();

    // Create a file and read it back
    await terminal.typeCommand("echo 'e2e-content' > /tmp/e2e-test.txt");
    // Small delay to let the first command complete
    await terminal.waitForOutput("$", 5_000).catch(() => {});

    await terminal.typeCommand("cat /tmp/e2e-test.txt");
    await terminal.waitForOutput("e2e-content");
  });
});
