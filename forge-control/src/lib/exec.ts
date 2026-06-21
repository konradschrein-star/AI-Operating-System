import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";

const execAsync = promisify(execCb);

export async function run(
  cmd: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? String(err),
    };
  }
}
