/**
 * Catalog artifact validation: provenance, schema, serving-set guarantees,
 * and stable deterministic ids.
 */
import bundle from '../data/foods.json';
import { describe, expect, it } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('data/foods.json', () => {
  it('ships a metadata record with source, license, and version', () => {
    expect(bundle.metadata.sourceName).toContain('USDA');
    expect(bundle.metadata.license).toContain('Public domain');
    expect(bundle.metadata.version).toMatch(/^usda-fdc-/);
    expect(bundle.metadata.foodCount).toBe(bundle.foods.length);
    expect(bundle.metadata.foodCount).toBeGreaterThan(100);
  });

  it('has unique deterministic ids and names', () => {
    const ids = bundle.foods.map((f) => f.id);
    const names = bundle.foods.map((f) => f.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const id of ids) expect(id).toMatch(UUID_RE);
  });

  it('every food has valid nutrition + provenance fields', () => {
    for (const f of bundle.foods) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(f.caloriesPer100g)).toBe(true);
      expect(f.caloriesPer100g).toBeGreaterThanOrEqual(0);
      expect(f.source).toBe('catalog');
      expect(f.ownerId).toBeNull();
      expect(f.sourceRef).toContain('USDA FDC');
      expect(f.servings.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('every food carries the base serving set: g, oz, cup, tbsp, tsp', () => {
    for (const f of bundle.foods) {
      const labels = new Set(f.servings.map((s) => s.label));
      expect(labels.has('g'), `${f.name}: g`).toBe(true);
      expect(labels.has('oz'), `${f.name}: oz`).toBe(true);
      expect([...labels].some((l) => l.startsWith('cup')), `${f.name}: cup`).toBe(true);
      expect(labels.has('tbsp'), `${f.name}: tbsp`).toBe(true);
      expect(labels.has('tsp'), `${f.name}: tsp`).toBe(true);
    }
  });

  it('serving gram weights are positive and consistent', () => {
    for (const f of bundle.foods) {
      for (const s of f.servings) {
        expect(Number.isFinite(s.grams), `${f.name}/${s.label}`).toBe(true);
        expect(s.grams).toBeGreaterThan(0);
        expect(typeof s.approx).toBe('boolean');
      }
      // tsp = tbsp/3 and tbsp = cup/16 when derived (approx consistency)
      const cup = f.servings.find((s) => s.label.startsWith('cup'));
      const tbsp = f.servings.find((s) => s.label === 'tbsp');
      const tsp = f.servings.find((s) => s.label === 'tsp');
      if (cup && tbsp && tbsp.approx) {
        expect(Math.abs(tbsp.grams - cup.grams / 16)).toBeLessThan(0.6);
      }
      if (tbsp && tsp && tsp.approx && tbsp) {
        expect(Math.abs(tsp.grams - tbsp.grams / 3)).toBeLessThan(0.3);
      }
    }
  });

  it('a serving labeled handful is always flagged approximate', () => {
    for (const f of bundle.foods) {
      for (const s of f.servings) {
        if (s.label === 'handful') expect(s.approx).toBe(true);
      }
    }
  });
});
