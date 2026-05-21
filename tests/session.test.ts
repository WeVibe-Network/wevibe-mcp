import { describe, it, expect } from 'vitest';
import { normalize_term, extract_tech_terms, dissect_to_keywords } from '../src/session.js';
import type { SessionContext } from '../src/types.js';

describe('session', () => {
  describe('normalize_term', () => {
    it('normalizes dashes and dots', () => {
      expect(normalize_term('fast-api')).toBe('fast_api');
      expect(normalize_term('v2.0')).toBe('v2_0');
    });

    it('removes version suffixes', () => {
      expect(normalize_term('pytest>=3.0')).toBe('pytest');
      expect(normalize_term('pydantic[yaml]')).toBe('pydantic');
    });

    it('strips whitespace', () => {
      expect(normalize_term('  python  ')).toBe('python');
    });
  });

  describe('extract_tech_terms', () => {
    it('extracts simple terms', () => {
      const terms = extract_tech_terms('python fastapi postgresql');
      expect(terms).toContain('python');
      expect(terms).toContain('fastapi');
      expect(terms).toContain('postgresql');
    });

    it('filters common English words', () => {
      const terms = extract_tech_terms('the and or but');
      expect(terms).not.toContain('the');
      expect(terms).not.toContain('and');
      expect(terms).not.toContain('or');
      expect(terms).not.toContain('but');
    });

    it('filters short terms', () => {
      const terms = extract_tech_terms('a b c python');
      expect(terms).not.toContain('a');
      expect(terms).not.toContain('b');
      expect(terms).not.toContain('c');
      expect(terms).toContain('python');
    });
  });

  describe('dissect_to_keywords', () => {
    it('produces weighted keywords', () => {
      const ctx: SessionContext = {
        projectName: 'test_project',
        technologies: ['python', 'fastapi'],
        recentActivity: ['added feature x'],
        directory: 'test_project',
        description: 'A FastAPI project',
      };
      const keywords = dissect_to_keywords(ctx);
      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords.every((kw) => 'term' in kw && 'weight' in kw)).toBe(true);
    });

    it('weights sum to one', () => {
      const ctx: SessionContext = {
        projectName: 'test',
        technologies: ['python'],
        recentActivity: [],
        directory: 'test',
        description: '',
      };
      const keywords = dissect_to_keywords(ctx);
      const total = keywords.reduce((sum, kw) => sum + kw.weight, 0);
      expect(Math.abs(total - 1.0)).toBeLessThan(0.0001);
    });

    it('manifest tech has highest weight', () => {
      const ctx: SessionContext = {
        projectName: 'test',
        technologies: ['python', 'fastapi'],
        recentActivity: [],
        directory: 'test',
        description: '',
      };
      const keywords = dissect_to_keywords(ctx);
      const kwMap = new Map(keywords.map((kw) => [kw.term, kw.weight]));
      expect((kwMap.get('python') ?? 0) >= (kwMap.get('fastapi') ?? 0)).toBe(true);
    });

    it('filters noise terms', () => {
      const ctx: SessionContext = {
        projectName: 'test',
        technologies: ['python'],
        recentActivity: ['update README and index'],
        directory: 'test',
        description: '',
      };
      const keywords = dissect_to_keywords(ctx);
      const terms = keywords.map((kw) => kw.term);
      expect(terms).not.toContain('readme');
      expect(terms).not.toContain('index');
    });

    it('filters common English', () => {
      const ctx: SessionContext = {
        projectName: 'test',
        technologies: ['python'],
        recentActivity: ['the and or but'],
        directory: 'test',
        description: 'the quick brown fox',
      };
      const keywords = dissect_to_keywords(ctx);
      const terms = keywords.map((kw) => kw.term);
      expect(terms).not.toContain('the');
      expect(terms).not.toContain('and');
    });

    it('normalizes terms with version suffixes', () => {
      const ctx: SessionContext = {
        projectName: 'test',
        technologies: ['python>=3.10'],
        recentActivity: [],
        directory: 'test',
        description: '',
      };
      const keywords = dissect_to_keywords(ctx);
      const terms = keywords.map((kw) => kw.term);
      expect(terms).not.toContain('python3_10');
      expect(terms).toContain('python');
    });

    it('returns empty for empty context', () => {
      const ctx: SessionContext = {
        projectName: '',
        technologies: [],
        recentActivity: [],
        directory: '',
        description: '',
      };
      const keywords = dissect_to_keywords(ctx);
      expect(keywords).toEqual([]);
    });
  });
});
