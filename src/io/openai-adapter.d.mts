import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';
export declare class OpenAIAdapter implements ProviderAdapter {
    id: ProviderId;
    generate(options: GenerateOptions): Promise<GenerationResult>;
}
