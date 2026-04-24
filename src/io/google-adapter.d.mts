import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';
export declare class GoogleAdapter implements ProviderAdapter {
    id: ProviderId;
    generate(options: GenerateOptions): Promise<GenerationResult>;
}
