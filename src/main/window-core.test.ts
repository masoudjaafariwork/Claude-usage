import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resizedBounds, type Rect } from './window-core';

// A 1920 × 1032 work area (taskbar at the bottom) with the primary display's origin.
const area: Rect = { x: 0, y: 0, width: 1920, height: 1032 };

test('resizedBounds keeps the top-left corner in the top-left half', () => {
  assert.deepEqual(resizedBounds({ x: 100, y: 100, width: 312, height: 248 }, area, 312, 400, true), {
    x: 100,
    y: 100,
    width: 312,
    height: 400,
  });
});

test('resizedBounds keeps the nearest edges in the bottom-right half', () => {
  const current = { x: 1592, y: 700, width: 312, height: 248 };
  assert.deepEqual(resizedBounds(current, area, 336, 300, true), { x: 1568, y: 648, width: 336, height: 300 });
  // Without keepNearestEdge (first fit at a restored position) the top-left corner stays.
  assert.deepEqual(resizedBounds(current, area, 320, 200, false), { x: 1592, y: 700, width: 320, height: 200 });
});

test('resizedBounds pulls a growing window back onto its display', () => {
  // Top half, grows past the bottom: moved up just enough.
  assert.deepEqual(resizedBounds({ x: 100, y: 400, width: 312, height: 100 }, area, 312, 700, true), {
    x: 100,
    y: 332,
    width: 312,
    height: 700,
  });
  // No edge anchoring, would leave at the right and bottom.
  assert.deepEqual(resizedBounds({ x: 1700, y: 900, width: 200, height: 100 }, area, 312, 248, false), {
    x: 1608,
    y: 784,
    width: 312,
    height: 248,
  });
});

test('resizedBounds keeps the top-left part visible when the window is bigger than the display', () => {
  const small: Rect = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(resizedBounds({ x: 300, y: 200, width: 312, height: 248 }, small, 900, 700, true), {
    x: 0,
    y: 0,
    width: 900,
    height: 700,
  });
});

test('resizedBounds leaves a window parked across two displays where it is (D44)', () => {
  // The owner's layout: a 1920 × 1080 display right of the primary, a portrait one further right
  // whose top is lower. Dropped across the boundary, mostly on the portrait display.
  const portrait: Rect = { x: 4992, y: 312, width: 1080, height: 1872 };
  const current = { x: 4937, y: 251, width: 344, height: 425 };
  assert.deepEqual(resizedBounds(current, portrait, 344, 426, true), { x: 4937, y: 251, width: 344, height: 426 });
  // Same across a left/right boundary with the tops aligned: it isn't pushed fully onto one side.
  const straddling = { x: 1800, y: 100, width: 312, height: 248 };
  assert.deepEqual(resizedBounds(straddling, area, 312, 250, true), { x: 1800, y: 100, width: 312, height: 250 });
});

test('resizedBounds never lets a window that already sticks out grow further out', () => {
  // 50 DIPs below the work area (on a display underneath); grows by 100 downwards → moves up 100,
  // so its bottom stays where it was.
  assert.deepEqual(resizedBounds({ x: 100, y: 834, width: 312, height: 248 }, area, 312, 348, false), {
    x: 100,
    y: 734,
    width: 312,
    height: 348,
  });
});
