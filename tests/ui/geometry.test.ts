import { describe, it, expect } from 'vitest';
import {
    computeControlLayout,
    defaultControlSize,
    DEFAULT_CONTROL_SIZE,
    CONTROL_LABEL_HEIGHT,
    CONTROL_MIN_SIZE,
    KNOB_MIN_SIZE,
    KNOB_MAX_SIZE,
} from '../../src/ui/geometry';
import { Control } from '../../src/core/model/Control';

describe('Control geometry — GUI repair invariants', () => {
    it('new controls default to a sensible size instead of a tiny 60×60 block', () => {
        expect(defaultControlSize('knob')).toEqual({ width: 120, height: 120 });
        expect(defaultControlSize('switch')).toEqual({ width: 120, height: 120 });

        const c = new Control('knob', 'Cutoff');
        expect(c.size).toEqual({ width: 120, height: 120 });
    });

    it('the knob is always square for any control size (never an ellipse)', () => {
        const sizes = [
            { width: 48, height: 48 },
            { width: 60, height: 60 },
            { width: 120, height: 120 },
            { width: 120, height: 80 },
            { width: 200, height: 140 },
            { width: 300, height: 90 },
        ];
        for (const size of sizes) {
            const layout = computeControlLayout(size, 'knob');
            expect(
                layout.widgetWidth,
                `expected square knob for w=${size.width}, h=${size.height}`,
            ).toBe(layout.widgetHeight);
        }
    });

    it('the knob fits inside the visual area (no oval/clipped rendering)', () => {
        const sizes = [
            { width: 120, height: 120 },
            { width: 120, height: 80 },
            { width: 200, height: 200 },
            { width: 300, height: 120 },
        ];
        for (const size of sizes) {
            const layout = computeControlLayout(size, 'knob');
            expect(layout.visualAreaWidth).toBeGreaterThanOrEqual(layout.widgetWidth);
            expect(layout.visualAreaHeight).toBeGreaterThanOrEqual(layout.widgetHeight);
            expect(layout.visualAreaHeight).toBeGreaterThanOrEqual(CONTROL_LABEL_HEIGHT);
        }
    });

    it('the label footer is always reserved at the bottom of the container', () => {
        const layout = computeControlLayout({ width: 120, height: 120 }, 'knob');
        expect(layout.labelHeight).toBe(CONTROL_LABEL_HEIGHT);
        expect(layout.visualAreaHeight).toBe(120 - CONTROL_LABEL_HEIGHT);
    });

    it('knob size is clamped to a sane range for extreme sizes', () => {
        const extremes = [
            { width: 40, height: 100 },
            { width: 600, height: 600 },
            { width: 500, height: 30 },
        ];
        for (const size of extremes) {
            const layout = computeControlLayout(size, 'knob');
            expect(layout.widgetWidth).toBeGreaterThanOrEqual(KNOB_MIN_SIZE);
            expect(layout.widgetHeight).toBeLessThanOrEqual(KNOB_MAX_SIZE);
            expect(layout.widgetWidth).toBe(layout.widgetHeight);
        }
    });

    it('the resize floor keeps controls usable (label + widget still fit)', () => {
        expect(CONTROL_MIN_SIZE.width).toBe(48);
        expect(CONTROL_MIN_SIZE.height).toBe(48);
        const layout = computeControlLayout(CONTROL_MIN_SIZE, 'knob');
        expect(layout.widgetWidth).toBe(layout.widgetHeight);
        expect(CONTROL_MIN_SIZE.height - CONTROL_LABEL_HEIGHT).toBeGreaterThan(0);
    });

    it('default control width accommodates typical spelled-out labels on one line', () => {
        // "RESONANCE" is the longest conventional label; at ~11px it needs well
        // under the 120px default width, so no premature word-wrap (§5).
        const layout = computeControlLayout(DEFAULT_CONTROL_SIZE, 'knob');
        expect(layout.visualAreaWidth).toBeGreaterThan(100);
        expect(DEFAULT_CONTROL_SIZE.width).toBeGreaterThan("RESONANCE".length * 10);
    });

    it('the visual area is rectangular and distinct from the square knob', () => {
        const layout = computeControlLayout({ width: 120, height: 120 }, 'knob');
        expect(layout.visualAreaWidth).toBe(120);
        // Label footer is reserved, so the area is wider than tall.
        expect(layout.visualAreaHeight).toBeLessThan(layout.visualAreaWidth);
        expect(layout.widgetWidth).toBeLessThan(layout.visualAreaHeight);
    });

    it('switch layout keeps a rectangular rail while the thumb stays round', () => {
        const layout = computeControlLayout({ width: 120, height: 120 }, 'switch');
        expect(layout.widgetWidth).toBeLessThan(layout.widgetHeight); // vertical rail
        expect(layout.labelHeight).toBe(CONTROL_LABEL_HEIGHT);
    });
});