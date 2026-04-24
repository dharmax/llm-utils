import { SystemStatus } from "../types.mjs";
/**
 * Superb System Probing logic plucked from core/services/lean-ctx.mjs
 */
export declare class SystemProbe {
    static getStatus(): Promise<SystemStatus>;
    private static probeLeanCtx;
    private static probeLeanCtxVersion;
    static leanCtxInstallHint(): string;
    static leanCtxSetupHint(): string;
}
