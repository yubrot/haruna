import { describe, expect, test } from "bun:test";
import { runPty } from "./index.ts";

/** Poll accumulated PTY output until `marker` appears or timeout is reached. */
async function waitForOutput(
  chunks: Uint8Array[],
  marker: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Buffer.concat(chunks).toString().includes(marker)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for "${marker}" in PTY output`);
}

describe("runPty", () => {
  describe("passthrough mode", () => {
    test("returns child process exit code 0", async () => {
      const session = runPty({
        command: ["true"],
      });
      expect(await session.exited).toBe(0);
    });

    test("returns non-zero exit code from child", async () => {
      const session = runPty({
        command: ["false"],
      });
      expect(await session.exited).not.toBe(0);
    });

    test("returns specific exit code from child", async () => {
      const session = runPty({
        command: ["sh", "-c", "exit 42"],
      });
      expect(await session.exited).toBe(42);
    });

    test("calls onData with PTY output", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["echo", "hello-from-pty"],
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      expect(await session.exited).toBe(0);
      expect(chunks.length).toBeGreaterThan(0);

      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("hello-from-pty");
    });

    test("passes custom environment variables to child", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "echo $HARUNA_TEST_VAR"],
        env: { HARUNA_TEST_VAR: "test-value-123" },
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("test-value-123");
    });

    test("accepts onResize callback without error", async () => {
      const session = runPty({
        command: ["true"],
        onResize: () => {},
      });
      expect(await session.exited).toBe(0);
    });

    test("write() sends data to child process stdin", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "echo READY; read -r line; echo received:$line"],
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      await waitForOutput(chunks, "READY");
      session.write("test-input\n");

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("received:test-input");
    });

    test("write() accepts Uint8Array", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "echo READY; read -r line; echo got:$line"],
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      await waitForOutput(chunks, "READY");
      session.write(new TextEncoder().encode("binary-input\n"));

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("got:binary-input");
    });

    test("write() is no-op after child exits", async () => {
      const session = runPty({
        command: ["true"],
      });
      await session.exited;
      // Should not throw — write is silently ignored after exit
      session.write("ignored");
    });
  });

  describe("headless mode", () => {
    test("returns child process exit code 0", async () => {
      const session = runPty({
        command: ["true"],
        passthrough: false,
      });
      expect(await session.exited).toBe(0);
    });

    test("returns non-zero exit code from child", async () => {
      const session = runPty({
        command: ["false"],
        passthrough: false,
      });
      expect(await session.exited).not.toBe(0);
    });

    test("delivers output via onData", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["echo", "headless-output"],
        passthrough: false,
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      expect(await session.exited).toBe(0);
      expect(chunks.length).toBeGreaterThan(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("headless-output");
    });

    test("write() sends data to child process", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "echo READY; read -r line; echo got:$line"],
        passthrough: false,
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      await waitForOutput(chunks, "READY");
      session.write("headless-write\n");

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("got:headless-write");
    });

    test("kill() terminates the child process", async () => {
      const session = runPty({
        command: ["sh", "-c", "sleep 60"],
        passthrough: false,
      });

      // Give the process a moment to start
      await Bun.sleep(100);
      session.kill("SIGTERM");

      const exitCode = await session.exited;
      // Process should have exited (non-zero due to signal)
      expect(exitCode).not.toBe(0);
    });

    test("uses specified cols and rows", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "tput cols; tput lines"],
        passthrough: false,
        cols: 120,
        rows: 40,
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("120");
      expect(output).toContain("40");
    });

    test("defaults to 80x24 without explicit dimensions", async () => {
      const chunks: Uint8Array[] = [];
      const session = runPty({
        command: ["sh", "-c", "tput cols; tput lines"],
        passthrough: false,
        onData: (data) => chunks.push(new Uint8Array(data)),
      });

      expect(await session.exited).toBe(0);
      const output = Buffer.concat(chunks).toString();
      expect(output).toContain("80");
      expect(output).toContain("24");
    });
  });
});
