import { describe, expect, it } from 'vitest';
import { declutter, groupOverlapping, type LabelIn } from '../../shared/declutter.js';

const at = (x: number, y: number, prio: number, extra: Partial<LabelIn> = {}): LabelIn => ({ x, y, w: 100, h: 20, anchor: 'top', offset: [0, 14], prio, ...extra });

describe('map label placement', () => {
  it('keeps labels where they are when nothing overlaps', () => {
    const r = declutter([at(100, 100, 1), at(400, 400, 2)]);
    expect(r).toEqual([{ offset: [0, 14] }, { offset: [0, 14] }]);
  });

  it('moves the less important of two stacked labels to a free side', () => {
    const r = declutter([at(200, 200, 5), at(200, 205, 0)]);
    expect(r[1]).toEqual({ offset: [0, 14] }); // the LKP keeps its spot
    expect(r[0]).not.toBeNull();
    expect(r[0]!.offset).not.toEqual([0, 14]);
  });

  it('hides what cannot fit, but never a label that must show', () => {
    const crowd = [at(200, 200, 0, { keep: true }), ...Array.from({ length: 6 }, (_, i) => at(200 + i, 200 + i, 5))];
    const r = declutter(crowd);
    expect(r[0]).toEqual({ offset: [0, 14] });
    expect(r.filter((x) => x === null).length).toBeGreaterThan(0);
    const keep = declutter([at(200, 200, 0), at(200, 200, 9, { keep: true })]);
    expect(keep[1]).not.toBeNull();
  });

  it('keeps labels off other points but not off their own', () => {
    // a dot just below point 0, where its label would hang
    const r = declutter([at(200, 200, 1)], [{ x: 200, y: 222, r: 10, owner: 1 }, { x: 200, y: 200, r: 12, owner: 0 }]);
    expect(r[0]!.offset).not.toEqual([0, 14]);
  });

  it('prefers a spot that stays on screen', () => {
    const r = declutter([at(780, 300, 1)], [], { w: 800, h: 600 });
    expect(r[0]!.offset[0]).toBeLessThan(0); // to the left of a point near the right edge
  });

  it('slides a label sideways to stay on screen, but not one whose point is off screen', () => {
    const r = declutter([at(780, 300, 1, { w: 300 }), at(900, 100, 1)], [], { w: 800, h: 600 });
    const box0 = 780 + r[0]!.offset[0] - 150;
    expect(box0 + 300).toBeLessThanOrEqual(800);
    expect(r[1]).toEqual({ offset: [0, 14] });
  });

  it('fixed labels (segments) either show in place or hide', () => {
    const r = declutter([at(300, 300, 0), at(300, 320, 8, { anchor: 'center', offset: [0, 0], w: 30, h: 16 })]);
    expect(r[1]).toBeNull();
  });

  it('groups crew of one team whose labels would overlap, not other teams or distant crew', () => {
    const l = [
      { ...at(200, 200, 2), group: '1' },
      { ...at(230, 210, 2), group: '1' },
      { ...at(320, 215, 2), group: '1' }, // overlaps the second only: same cluster
      { ...at(210, 205, 2), group: '2' },
      { ...at(600, 500, 2), group: '1' },
      at(205, 200, 5),
    ];
    expect(groupOverlapping(l)).toEqual([[0, 1, 2]]);
  });
});
