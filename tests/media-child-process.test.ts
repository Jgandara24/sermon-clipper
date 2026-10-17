import { describe, expect, it } from "vitest";
import { ChildProcessTimeoutError, execFileBufferWithTimeout, execFileWithTimeout } from "@/lib/media/child-process";

describe("bounded media child processes", () => {
  it("preserves binary frame bytes", async () => {
    const result = await execFileBufferWithTimeout(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,128,255]))"],
      { timeoutMs: 5000, maxBuffer: 1024 });
    expect(result.stdout).toEqual(Buffer.from([0, 128, 255]));
  });
  it.each([execFileWithTimeout, execFileBufferWithTimeout])("reports output overflow separately from timeout", async execute => {
    await expect(execute(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(4096))"],
      { timeoutMs: 5000, maxBuffer: 128 })).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
  it.each([execFileWithTimeout, execFileBufferWithTimeout])("terminates a child that exceeds its timeout", async execute => {
    await expect(execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50, maxBuffer: 1024 })).rejects.toBeInstanceOf(ChildProcessTimeoutError);
  });
});
