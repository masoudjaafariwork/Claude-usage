import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HoverWatch, containsPoint, type Point } from './hover';

const bounds = { x: 100, y: 50, width: 312, height: 248 };

test('containsPoint includes the top-left edge and excludes the bottom-right one', () => {
  assert.equal(containsPoint(bounds, { x: 100, y: 50 }), true);
  assert.equal(containsPoint(bounds, { x: 411, y: 297 }), true);
  assert.equal(containsPoint(bounds, { x: 412, y: 100 }), false);
  assert.equal(containsPoint(bounds, { x: 200, y: 298 }), false);
  assert.equal(containsPoint(bounds, { x: 99, y: 100 }), false);
});

function watch(): { hover: HoverWatch; moveTo(point: Point): void; changes: boolean[] } {
  let cursor: Point = { x: 0, y: 0 };
  const changes: boolean[] = [];
  const hover = new HoverWatch({ cursor: () => cursor, bounds: () => bounds, onChange: (h) => changes.push(h) });
  return {
    hover,
    moveTo(point) {
      cursor = point;
      hover.check();
    },
    changes,
  };
}

test('HoverWatch reports entering and leaving once each', () => {
  const { moveTo, changes } = watch();
  moveTo({ x: 10, y: 10 });
  moveTo({ x: 200, y: 100 });
  moveTo({ x: 210, y: 110 });
  moveTo({ x: 500, y: 100 });
  assert.deepEqual(changes, [true, false]);
});

test('HoverWatch holds after an opacity change until the cursor has left once', () => {
  const { hover, moveTo, changes } = watch();
  moveTo({ x: 200, y: 100 });
  hover.holdUntilLeave();
  moveTo({ x: 220, y: 120 }); // still on the overlay: the new opacity stays visible
  moveTo({ x: 600, y: 100 });
  moveTo({ x: 200, y: 100 });
  assert.deepEqual(changes, [true, false, true]);
});

test('HoverWatch switched off reports "not hovered" and forgets a hold', () => {
  const { hover, moveTo, changes } = watch();
  moveTo({ x: 200, y: 100 });
  hover.holdUntilLeave();
  hover.setActive(false);
  hover.setActive(true); // checks at once: still on the overlay, no hold any more
  hover.setActive(false);
  assert.deepEqual(changes, [true, false, true, false]);
});
