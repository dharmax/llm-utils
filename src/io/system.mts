import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SystemStatus } from "../types.mjs";

const execFileAsync = promisify(execFile);

/**
 * Superb System Probing logic plucked from core/services/lean-ctx.mjs
 */
export class SystemProbe {
  static async getStatus(): Promise<SystemStatus> {
    const leanCtx = await this.probeLeanCtx();
    return { ok: true, leanCtx };
  }

  private static async probeLeanCtx() {
    try {
      const { stdout } = await execFileAsync("bash", ["-lc", "command -v lean-ctx"], {
        maxBuffer: 1024 * 1024
      });
      const commandPath = String(stdout ?? "").trim();
      
      if (!commandPath) {
        return {
          installed: false,
          path: null,
          version: null,
          details: "lean-ctx not found on PATH",
          installHint: this.leanCtxInstallHint(),
          setupHint: this.leanCtxSetupHint()
        };
      }

      const version = await this.probeLeanCtxVersion();
      return {
        installed: true,
        path: commandPath,
        version,
        details: `lean-ctx available at ${commandPath}${version ? ` (${version})` : ""}`,
        installHint: this.leanCtxInstallHint(),
        setupHint: this.leanCtxSetupHint()
      };
    } catch (error: any) {
      return {
        installed: false,
        path: null,
        version: null,
        details: error?.message ?? String(error),
        installHint: this.leanCtxInstallHint(),
        setupHint: this.leanCtxSetupHint()
      };
    }
  }

  private static async probeLeanCtxVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("lean-ctx", ["--version"], {
        maxBuffer: 1024 * 1024
      });
      const match = String(stdout ?? "").match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      return match ? match[1] : String(stdout ?? "").trim() || null;
    } catch {
      return null;
    }
  }

  static leanCtxInstallHint() {
    return "Install the lean-ctx CLI and ensure `lean-ctx` is on PATH, then rerun `ai-workflow doctor`.";
  }

  static leanCtxSetupHint() {
    return "After install, verify with `lean-ctx -c git status` and use `lean-ctx -c <command>` for compressed shell output.";
  }
}
