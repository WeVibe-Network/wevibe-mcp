import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as toml from 'toml';

export async function read_project_manifest(workingDir: string = '.'): Promise<string[]> {
  const wd = resolve(workingDir);

  const packageDeps = read_package_json(join(wd, 'package.json'));
  if (packageDeps.length > 0) {
    return packageDeps;
  }

  const reqDeps = read_requirements_txt(join(wd, 'requirements.txt'));
  if (reqDeps.length > 0) {
    return reqDeps;
  }

  const pyprojectDeps = read_pyproject_toml(join(wd, 'pyproject.toml'));
  if (pyprojectDeps.length > 0) {
    return pyprojectDeps;
  }

  const cargoDeps = read_cargo_toml(join(wd, 'Cargo.toml'));
  if (cargoDeps.length > 0) {
    return cargoDeps;
  }

  const goDeps = read_go_mod(join(wd, 'go.mod'));
  if (goDeps.length > 0) {
    return goDeps;
  }

  return [];
}

export function read_package_json(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));

    const deps: string[] = [];
    for (const depDict of [data.dependencies ?? {}, data.devDependencies ?? {}]) {
      for (const name of Object.keys(depDict)) {
        const lowerName = name.toLowerCase();
        if (lowerName.startsWith('@')) {
          continue;
        }
        deps.push(lowerName);
      }
    }

    return deps;
  } catch {
    return [];
  }
}

export function read_requirements_txt(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    const deps: string[] = [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([a-zA-Z0-9_\-]+)/);
      if (match) {
        deps.push(match[1].toLowerCase());
      }
    }

    return deps;
  } catch {
    return [];
  }
}

export function read_pyproject_toml(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const data = toml.parse(content);

    const deps: string[] = [];
    const projectDeps = data.project?.dependencies ?? [];
    for (const dep of projectDeps) {
      const match = String(dep).match(/^([a-zA-Z0-9_\-]+)/);
      if (match) {
        deps.push(match[1].toLowerCase());
      }
    }

    const optionalDeps = data.project?.['optional-dependencies'] ?? {};
    for (const extraName of Object.keys(optionalDeps)) {
      const extraDepList = optionalDeps[extraName];
      if (Array.isArray(extraDepList)) {
        for (const dep of extraDepList) {
          const match = String(dep).match(/^([a-zA-Z0-9_\-]+)/);
          if (match) {
            deps.push(match[1].toLowerCase());
          }
        }
      }
    }

    return deps;
  } catch {
    return [];
  }
}

export function read_cargo_toml(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const data = toml.parse(content);

    const deps: string[] = [];
    const dependencies = data.dependencies ?? {};
    for (const name of Object.keys(dependencies)) {
      deps.push(name.toLowerCase());
    }

    return deps;
  } catch {
    return [];
  }
}

export function read_go_mod(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  try {
    const deps: string[] = [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');

    let inRequire = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === 'require (') {
        inRequire = true;
        continue;
      }

      if (inRequire) {
        if (trimmed === ')') {
          break;
        }
        const match = trimmed.match(/^([a-zA-Z0-9_\-./]+)\s/);
        if (match) {
          const module = match[1];
          const parts = module.split('/');
          if (parts.length >= 2) {
            deps.push(parts[parts.length - 1].toLowerCase());
          } else {
            deps.push(module.toLowerCase());
          }
        }
      }
    }

    return deps;
  } catch {
    return [];
  }
}
