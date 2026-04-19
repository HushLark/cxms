import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { Vendor } from './keys-config.js';

export type ModelRole = 'chat' | 'fast' | 'embed';
export const MODEL_ROLES: ModelRole[] = ['chat', 'fast', 'embed'];

export interface ModelsConfig {
    vendor?: Vendor;
    chat?: string;
    fast?: string;
    embed?: string;
}

export const SUITES: Record<Vendor, ModelsConfig> = {
    anthropic: {
        vendor: 'anthropic',
        chat: 'claude-opus-4-7',
        fast: 'claude-haiku-4-5-20251001',
        embed: undefined,
    },
    openai: {
        vendor: 'openai',
        chat: 'gpt-4o',
        fast: 'gpt-4o-mini',
        embed: 'text-embedding-3-large',
    },
    gemini: {
        vendor: 'gemini',
        chat: 'gemini-2.5-pro',
        fast: 'gemini-2.5-flash',
        embed: 'text-embedding-004',
    },
    deepseek: {
        vendor: 'deepseek',
        chat: 'deepseek-chat',
        fast: 'deepseek-chat',
        embed: undefined,
    },
};

const modelsFile = () => path.join(os.homedir(), '.cxms', 'models.json');

export async function loadModels(): Promise<ModelsConfig> {
    try {
        return JSON.parse(await fs.readFile(modelsFile(), 'utf8'));
    } catch {
        return {};
    }
}

export async function saveModels(config: ModelsConfig): Promise<void> {
    const file = modelsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2));
}

export async function setModel(role: ModelRole, model: string): Promise<void> {
    const current = await loadModels();
    current[role] = model;
    delete current.vendor; // no longer a pure suite
    await saveModels(current);
}
