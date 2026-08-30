import type { ControlType, Position, Size } from "../core/model/types";

/**
 * Control geometry (§ GUI repair).
 *
 * A Metatron Control is a rectangular container made of:
 *   1. the rectangular Visual Area  (configurable color, holds the widget)
 *   2. the Label area               (name + binding status)
 *
 * The widget (knob) that lives inside the Visual Area is always geometrically
 * square (aspect-ratio 1/1, border-radius 50%). Resizing the Control only ever
 * changes the container; the knob is re-derived from the width/height so it
 * can never become an ellipse.
 */

// ── Layout versioning ───────────────────────────────────────────────────────
// Controls created before the geometry repair have no layoutVersion field (or
// layoutVersion: undefined). The current layout version marks Controls whose
// geometry is already compatible with the post-repair system. The version is
// serialized so that one-time migration runs exactly once per Control.

/** The current layout version. Controls with this version need no migration. */
export const CURRENT_LAYOUT_VERSION = 2;

/**
 * Minimum size a legacy Control must have to be considered intentionally
 * resized under the current layout system. Controls smaller than this AND
 * without a layoutVersion are assumed to belong to the old 60×60 layout.
 */
export const LEGACY_MAX_SIZE_BEFORE_MIGRATION = 80;

// ── Geometry constants ──────────────────────────────────────────────────────

export const DEFAULT_CONTROL_SIZE: Size = { width: 120, height: 120 };
export const CONTROL_LABEL_HEIGHT = 26;
export const CONTROL_MIN_SIZE: Size = { width: 48, height: 48 };
export const CONTROL_VISUAL_PADDING = 12;
export const KNOB_MIN_SIZE = 24;
export const KNOB_MAX_SIZE = 72;
export const SWITCH_MAX_WIDTH = 48;

/**
 * Padding added around a Group's member bounds when the Group container is
 * expanded during the one-time legacy migration.
 */
export const GROUP_PADDING = 16;

export interface ControlLayout {
    /** Fixed-height footer holding the label + status. */
    labelHeight: number;
    /** The rectangular visual area that carries the configurable color. */
    visualAreaWidth: number;
    visualAreaHeight: number;
    /** Widget dimensions inside the visual area (knob: square). */
    widgetWidth: number;
    widgetHeight: number;
}

export function defaultControlSize(_type: ControlType): Size {
    // A sensible default for new controls: enough room for visual area + label.
    return { ...DEFAULT_CONTROL_SIZE };
}

/**
 * Derive the full layout of a Control from its stored size.
 * Invariants:
 *   - labelHeight is always reserved at the bottom of the container;
 *   - the knob is always square and never exceeds the visual area bounds;
 *   - the widget is clamped to a sane size range for very small controls.
 */
export function computeControlLayout(size: Size, type: ControlType): ControlLayout {
    const labelHeight = CONTROL_LABEL_HEIGHT;
    const visualAreaWidth = Math.max(1, size.width);
    const visualAreaHeight = Math.max(1, size.height - labelHeight);

    const maxWidget = Math.min(visualAreaWidth, visualAreaHeight) - CONTROL_VISUAL_PADDING * 2;

    if (type === "knob") {
        const diameter = clamp(Math.max(KNOB_MIN_SIZE, maxWidget), KNOB_MIN_SIZE, KNOB_MAX_SIZE);
        return {
            labelHeight,
            visualAreaWidth,
            visualAreaHeight,
            widgetWidth: diameter,
            widgetHeight: diameter,
        };
    }

    // Switch: a vertical toggle rail. The rail is rectangular by design, but
    // its circular toggle thumb stays round (border-radius: 50%).
    const railWidth = clamp(Math.max(KNOB_MIN_SIZE, maxWidget), KNOB_MIN_SIZE, SWITCH_MAX_WIDTH);
    const railHeight = Math.min(visualAreaHeight, railWidth * 1.6);
    return {
        labelHeight,
        visualAreaWidth,
        visualAreaHeight,
        widgetWidth: railWidth,
        widgetHeight: railHeight,
    };
}

/** Ensure a knob diameter stays square and within the allowed range. */
export function clampedKnobSize(requested: number): number {
    return clamp(requested, KNOB_MIN_SIZE, KNOB_MAX_SIZE);
}

/**
 * Determine whether a serialized Control needs a one-time geometry migration.
 *
 * A Control is "legacy" when ALL of these are true:
 *   1. layoutVersion is missing or < CURRENT_LAYOUT_VERSION
 *   2. Its stored size is small enough that it was clearly created under the
 *      old default (≤ LEGACY_MAX_SIZE_BEFORE_MIGRATION in both dimensions).
 *
 * This avoids accidentally resizing Controls that the user deliberately
 * shrank to a small size after the geometry repair shipped.
 */
export function controlNeedsLegacyMigration(data: any): boolean {
    const lv = data.layoutVersion;
    if (lv !== undefined && lv >= CURRENT_LAYOUT_VERSION) return false;
    const size = data.size;
    if (!size || typeof size.width !== "number" || typeof size.height !== "number") return false;
    return size.width <= LEGACY_MAX_SIZE_BEFORE_MIGRATION && size.height <= LEGACY_MAX_SIZE_BEFORE_MIGRATION;
}

// ── Group bounds (legacy group migration) ───────────────────────────────────
// When legacy Controls inside a Group are migrated to the new default size,
// the Group container must be expanded so it still fully contains its member
// Controls. This runs once, as part of the same migration pass.

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Bounding rectangle that exactly covers all member Controls, or null if empty. */
export function groupMemberBounds(controls: Array<{ position: Position; size: Size }>): Rect | null {
    if (controls.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of controls) {
        const right = c.position.x + c.size.width;
        const bottom = c.position.y + c.size.height;
        if (c.position.x < minX) minX = c.position.x;
        if (c.position.y < minY) minY = c.position.y;
        if (right > maxX) maxX = right;
        if (bottom > maxY) maxY = bottom;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Grow a rectangle by `padding` on all edges. */
export function inflatedRect(r: Rect, padding: number): Rect {
    return { x: r.x - padding, y: r.y - padding, width: r.width + padding * 2, height: r.height + padding * 2 };
}

/** True when `outer` fully contains `inner` (with exact coordinates). */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
    return (
        outer.x <= inner.x &&
        outer.y <= inner.y &&
        outer.x + outer.width >= inner.x + inner.width &&
        outer.y + outer.height >= inner.y + inner.height
    );
}

/** Smallest rectangle containing both `a` and `b`. */
export function unionRect(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return { x, y, width: right - x, height: bottom - y };
}

/**
 * Compute the bounds a Group should take after its members migrated to the
 * current geometry: union(current group bounds, member bounds + padding).
 * If the current bounds already fully contain the padded member bounds, the
 * Group is left untouched → the operation is idempotent.
 */
export function migratedGroupRect(
    group: { position: Position; size: Size },
    members: Array<{ position: Position; size: Size }>,
    padding: number = GROUP_PADDING
): Rect {
    const bounds = groupMemberBounds(members);
    if (!bounds) return { x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height };

    const current: Rect = { x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height };
    const needed = inflatedRect(bounds, padding);
    if (rectContainsRect(current, needed)) return current;
    return unionRect(current, needed);
}

/**
 * Pick a readable text color for a given background color.
 * Light backgrounds get dark text, dark backgrounds get white text.
 * Supports `#rgb` and `#rrggbb`.
 */
export function contrastTextColor(hex: string): string {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return "#fff";
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 150 ? "#101010" : "#fff";
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}