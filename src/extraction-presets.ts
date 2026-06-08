import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function readPrompt(relativePath: string): string {
  return readFileSync(join(PROMPTS_DIR, relativePath), 'utf8').replace(/\n$/, '');
}

const CONTRACT = readPrompt('memory-extraction/contract.md');

const GATES = readPrompt('memory-extraction/gates.md');

const EXEMPLAR = readPrompt('memory-extraction/exemplar.md');

const STRATEGY_FACTUAL_STRICT = readPrompt('memory-extraction/strategy-factual-strict.md');

const STRATEGY_GUARDRAIL_MAX = readPrompt('memory-extraction/strategy-guardrail-max.md');

const STRATEGY_BALANCED_RELIABLE = readPrompt('memory-extraction/strategy-balanced-reliable.md');

export interface ExtractionPreset { id: string; label: string; goal: string; recommended: boolean; system_prompt: string; }

export const EXTRACTION_PRESETS: ExtractionPreset[] = [
  { id: 'factual-strict',    label: 'Factual-Strict',    goal: 'Minimize preference, maximize specificity (fewer, sharper memories).', recommended: false, system_prompt: STRATEGY_FACTUAL_STRICT + '\n\n' + GATES + '\n\n' + EXEMPLAR + '\n\n' + CONTRACT },
  { id: 'guardrail-max',     label: 'Guardrail-Max',     goal: 'Maximize high-quality negative signals (DND footguns + fixes).',      recommended: false, system_prompt: STRATEGY_GUARDRAIL_MAX + '\n\n' + GATES + '\n\n' + EXEMPLAR + '\n\n' + CONTRACT },
  { id: 'balanced-reliable', label: 'Balanced-Reliable', goal: 'Balanced, schema-stable, reliable + continuity (recommended).',       recommended: true,  system_prompt: STRATEGY_BALANCED_RELIABLE + '\n\n' + GATES + '\n\n' + EXEMPLAR + '\n\n' + CONTRACT },
];

export const RECOMMENDED_PRESET_ID = 'balanced-reliable';

export function getRecommendedPreset(): ExtractionPreset { return EXTRACTION_PRESETS.find(p => p.recommended) ?? EXTRACTION_PRESETS[EXTRACTION_PRESETS.length - 1]; }
