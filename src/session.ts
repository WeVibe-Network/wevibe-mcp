import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as toml from 'toml';
import type { SessionContext, Keyword } from './types.js';

const COMMON_ENGLISH = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'with', 'for', 'from', 'into',
  'about', 'between', 'through', 'after', 'before', 'above', 'below', 'and',
  'or', 'but', 'not', 'this', 'that', 'these', 'those', 'it', 'its', 'you',
  'your', 'we', 'our', 'they', 'their', 'my', 'i', 'me', 'he', 'she', 'to',
  'of', 'in', 'on', 'at', 'by', 'up', 'out', 'off', 'if', 'then', 'else',
  'when', 'while', 'how', 'what', 'where', 'which', 'who', 'whom', 'all',
  'each', 'every', 'any', 'some', 'no', 'more', 'most', 'other', 'than',
  'very', 'just', 'also', 'new', 'old', 'first', 'last', 'next', 'now',
  'only', 'still', 'even', 'back', 'well', 'much', 'many', 'here', 'there',
  'make', 'made', 'use', 'used', 'using', 'add', 'added', 'set', 'get', 'got',
  'run', 'fix', 'fixed', 'update', 'updated', 'change', 'changed', 'work',
  'works', 'working', 'implement', 'implemented', 'create', 'created', 'move',
  'moved', 'file', 'files', 'code', 'project', 'server', 'client', 'system',
  'data', 'error', 'test', 'tests', 'testing', 'support', 'feature', 'version',
  'config', 'configuration', 'setup', 'build', 'deploy', 'issue', 'bug', 'patch',
]);

const NOISE_TERMS = new Set([
  'readme', 'md', 'txt', 'src', 'lib', 'bin', 'dist', 'index', 'main', 'app',
  'init', 'utils', 'helpers',
]);

function read_project_manifest(workingDir: string): string[] {
  const wd = resolve(workingDir);
  const wdPath = (file: string) => join(wd, file);

  const packageDeps = (() => {
    const path = wdPath('package.json');
    if (!existsSync(path)) return [];
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const deps: string[] = [];
      for (const depDict of [data.dependencies ?? {}, data.devDependencies ?? {}]) {
        for (const name of Object.keys(depDict)) {
          const lowerName = name.toLowerCase();
          if (!lowerName.startsWith('@')) {
            deps.push(lowerName);
          }
        }
      }
      return deps;
    } catch {
      return [];
    }
  })();
  if (packageDeps.length > 0) return packageDeps;

  const reqDeps = (() => {
    const path = wdPath('requirements.txt');
    if (!existsSync(path)) return [];
    try {
      const deps: string[] = [];
      const content = readFileSync(path, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_\-]+)/);
        if (match) deps.push(match[1].toLowerCase());
      }
      return deps;
    } catch {
      return [];
    }
  })();
  if (reqDeps.length > 0) return reqDeps;

  const pyprojectDeps = (() => {
    const path = wdPath('pyproject.toml');
    if (!existsSync(path)) return [];
    try {
      const data = toml.parse(readFileSync(path, 'utf-8'));
      const deps: string[] = [];
      const projectDeps = data.project?.dependencies ?? [];
      for (const dep of projectDeps) {
        const match = String(dep).match(/^([a-zA-Z0-9_\-]+)/);
        if (match) deps.push(match[1].toLowerCase());
      }
      const optionalDeps = data.project?.['optional-dependencies'] ?? {};
      for (const extraDepList of Object.values(optionalDeps) as string[][]) {
        if (Array.isArray(extraDepList)) {
          for (const dep of extraDepList) {
            const match = String(dep).match(/^([a-zA-Z0-9_\-]+)/);
            if (match) deps.push(match[1].toLowerCase());
          }
        }
      }
      return deps;
    } catch {
      return [];
    }
  })();
  if (pyprojectDeps.length > 0) return pyprojectDeps;

  const cargoDeps = (() => {
    const path = wdPath('Cargo.toml');
    if (!existsSync(path)) return [];
    try {
      const data = toml.parse(readFileSync(path, 'utf-8'));
      const deps: string[] = [];
      for (const name of Object.keys(data.dependencies ?? {})) {
        deps.push(name.toLowerCase());
      }
      return deps;
    } catch {
      return [];
    }
  })();
  if (cargoDeps.length > 0) return cargoDeps;

  const goDeps = (() => {
    const path = wdPath('go.mod');
    if (!existsSync(path)) return [];
    try {
      const deps: string[] = [];
      const content = readFileSync(path, 'utf-8');
      let inRequire = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'require (') {
          inRequire = true;
          continue;
        }
        if (inRequire) {
          if (trimmed === ')') break;
          const match = trimmed.match(/^([a-zA-Z0-9_\-./]+)\s/);
          if (match) {
            const module = match[1];
            const parts = module.split('/');
            deps.push(parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : module.toLowerCase());
          }
        }
      }
      return deps;
    } catch {
      return [];
    }
  })();
  return goDeps;
}

export function detect_session(workingDir: string = '.'): SessionContext {
  const ctx: SessionContext = {
    projectName: '',
    technologies: [],
    recentActivity: [],
    directory: '',
    description: '',
  };

  const absDir = workingDir.replace(/\\/g, '/');
  ctx.directory = basename(absDir);
  ctx.projectName = ctx.directory.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');

  ctx.technologies = read_project_manifest(workingDir);
  ctx.description = _read_readme(absDir);
  ctx.recentActivity = _read_git_log(absDir);

  return ctx;
}

function _read_readme(projectDir: string): string {
  const names = ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README'];

  for (const name of names) {
    const path = join(projectDir, name);
    if (existsSync(path)) {
      try {
        return readFileSync(path, { encoding: 'utf-8', flag: 'r' }).slice(0, 500);
      } catch {
        // ignore
      }
    }
  }
  return '';
}

function _read_git_log(projectDir: string, count: number = 5): string[] {
  try {
    const result = execSync(`git log --max-count=${count} --format=%s`, {
      cwd: projectDir,
      timeout: 5000,
      encoding: 'utf-8',
    });

    if (result.trim()) {
      return result
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  } catch {
    // ignore
  }
  return [];
}

export function dissect_to_keywords(ctx: SessionContext): { term: string; weight: number }[] {
  const entries: { term: string; weight: number }[] = [];

  const descTerms = new Set<string>();
  if (ctx.description) {
    for (const term of extract_tech_terms(ctx.description)) {
      descTerms.add(term);
      entries.push({ term, weight: 1.0 });
    }
  }

  for (const tech of ctx.technologies) {
    const term = normalize_term(tech);
    if (term && term.length > 1) {
      const weight = descTerms.has(term) ? 1.0 : 0.5;
      entries.push({ term, weight });
    }
  }

  for (const msg of ctx.recentActivity) {
    for (const term of extract_tech_terms(msg)) {
      entries.push({ term, weight: 0.3 });
    }
  }

  if (ctx.projectName) {
    entries.push({ term: ctx.projectName, weight: 0.2 });
  }

  if (ctx.directory) {
    const dirTerm = ctx.directory.toLowerCase().replace(/[- ]/g, '_');
    if (dirTerm.length > 1 && dirTerm !== ctx.projectName) {
      entries.push({ term: dirTerm, weight: 0.2 });
    }
  }

  const weightMap = new Map<string, number>();
  for (const entry of entries) {
    if (NOISE_TERMS.has(entry.term)) {
      continue;
    }
    const current = weightMap.get(entry.term) ?? 0;
    weightMap.set(entry.term, Math.max(current, entry.weight));
  }

  const total = [...weightMap.values()].reduce((sum, w) => sum + w, 0);
  if (total === 0) {
    return [];
  }

  return [...weightMap.entries()]
    .map(([term, weight]) => ({
      term,
      weight: Math.round((weight / total) * 1e6) / 1e6,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);
}

export function normalize_term(term: string): string {
  let t = term.toLowerCase().trim();
  t = t.replace(/-/g, '_').replace(/\./g, '_').replace(/\//g, '_');
  t = t.replace(/[>=<~!].*$/, '');
  t = t.replace(/\[.*\]$/, '');
  t = t.trim().replace(/^_+|_+$/g, '');
  return t;
}

export function extract_tech_terms(text: string): string[] {
  const words = text.toLowerCase().split(/[\s,;:!?()\[\]{}"'`/]+/);
  const terms: string[] = [];

  for (const word of words) {
    const cleaned = normalize_term(word);
    if (cleaned && cleaned.length > 1 && !COMMON_ENGLISH.has(cleaned) && !/^\d+$/.test(cleaned)) {
      terms.push(cleaned);
    }
  }

  return terms;
}
