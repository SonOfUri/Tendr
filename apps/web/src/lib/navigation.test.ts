import { describe, expect, it } from 'vitest';
import { previewSlug, safeNext } from './navigation';

describe('safeNext', () => {
  it('keeps same-site paths and refuses others', () => {
    expect(safeNext('/dashboard/onboarding/second-key?add=device')).toBe(
      '/dashboard/onboarding/second-key?add=device',
    );
    expect(safeNext('//evil.example')).toBe('/dashboard');
    expect(safeNext('https://evil.example')).toBe('/dashboard');
    expect(safeNext('/\\evil.example')).toBe('/dashboard');
    expect(safeNext('/\n/evil.example')).toBe('/dashboard');
    expect(safeNext('/\t/evil.example')).toBe('/dashboard');
    expect(safeNext('/' + 'a'.repeat(2048))).toBe('/dashboard');
    expect(safeNext(null)).toBe('/dashboard');
  });
});

describe('previewSlug', () => {
  it('matches the API slug rules', () => {
    expect(previewSlug('Café Olé!')).toBe('cafe-ole');
    expect(previewSlug('ab')).toBe('ab-store');
    expect(previewSlug('***')).toBe('store');
    expect(previewSlug('a'.repeat(40))).toHaveLength(28);
  });
});
