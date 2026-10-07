export type PredicateQuestion = { name: string; type: 'predicate'; instructions: string };
export type PredicateAnswer = { name: string; type: 'predicate'; probability: number };
export type RefusalAnswer = { name: string | null; type: 'refusal' };
export type ImageData = { dataUrl: string; mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: number };
export type FetchOptions = { fetcher?: typeof fetch; timeoutMs?: number };
export type ImageOptions = FetchOptions & { allowedHosts?: readonly string[]; maxBytes?: number };
export type DecisionRequest = {
  model: string;
  input: [{ role: 'user'; content: [{ type: 'input_text'; text: string }, { type: 'input_image'; image_url: string }] }];
  questions: PredicateQuestion[];
};
export const DEFAULT_IMAGE_HOSTS: readonly string[];
export const MAX_IMAGE_BYTES: number;
export class InputError extends Error {}
export function imageBytesToDataUrl(bytes: Uint8Array): ImageData;
export function imageUrlToDataUrl(url: string, options?: ImageOptions): Promise<ImageData & { sourceUrl: string }>;
export function youtubeThumbnail(videoId: string, options?: FetchOptions & { apiKey?: string; maxBytes?: number }): Promise<ImageData & {
  sourceUrl: string; videoId: string; size: string; metadata: { title: string; description: string; tags: string[] };
}>;
export function listPresets(framework?: 'basic' | 'garm'): { version: string; questions: Record<string, string> };
export function presetQuestions(options?: { framework?: 'basic' | 'garm'; selected?: string[]; custom?: string[] }): PredicateQuestion[];
export function buildDecisionRequest(input: { dataUrl: string; questions: PredicateQuestion[]; text?: string; model?: string }): DecisionRequest;
export function createDecision(request: DecisionRequest, options?: FetchOptions & { apiKey?: string }): Promise<{
  answers: (PredicateAnswer | RefusalAnswer)[]; model?: string; usage?: Record<string, unknown>;
  latencyMs: number; hasRefusal: boolean;
}>;
