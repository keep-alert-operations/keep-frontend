export interface GridPanel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width grows one column at a time up to the full row; height has no maximum. */
export const MIN_PANEL_WIDTH = 3;
export const MIN_PANEL_HEIGHT = 2;

export function layoutOrder(a: GridPanel, b: GridPanel) {
  return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

function overlaps(a: GridPanel, b: GridPanel) {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/** Apply vertical gravity without letting a panel pass an earlier horizontal blocker. */
export function compactPanels<T extends GridPanel>(panels: T[]): T[] {
  const settled: T[] = [];
  for (const panel of [...panels].sort(layoutOrder)) {
    const blockers = settled.filter(
      (other) => panel.x < other.x + other.w && other.x < panel.x + panel.w,
    );
    settled.push({
      ...panel,
      y: blockers.length
        ? Math.max(...blockers.map((other) => other.y + other.h))
        : 0,
    });
  }
  return settled.sort(layoutOrder);
}

/** Prioritize the edited rectangle, displace collisions, then settle the whole layout. */
export function placePanel<T extends GridPanel>(
  panels: T[],
  id: string,
  patch: Partial<Pick<GridPanel, "x" | "y" | "w" | "h">>,
): T[] | null {
  const original = panels.find((panel) => panel.id === id);
  if (!original) return null;
  const edited = { ...original, ...patch };
  if (
    ![edited.x, edited.y, edited.w, edited.h].every(Number.isInteger) ||
    edited.w < MIN_PANEL_WIDTH ||
    edited.h < MIN_PANEL_HEIGHT ||
    edited.x < 0 ||
    edited.y < 0 ||
    edited.x + edited.w > 12
  )
    return null;
  const settled: T[] = [edited];
  for (const panel of [...panels].sort(layoutOrder)) {
    if (panel.id === id) continue;
    let next = { ...panel };
    let collisions = settled.filter((other) => overlaps(next, other));
    while (collisions.length) {
      next = {
        ...next,
        y: Math.max(...collisions.map((other) => other.y + other.h)),
      };
      collisions = settled.filter((other) => overlaps(next, other));
    }
    settled.push(next);
  }
  const compacted = compactPanels(settled);
  return compacted.some((panel) => panel.y + panel.h > 100) ? null : compacted;
}

/** Adding fills the first row-major gap in the compacted layout. */
export function firstPanelGap<T extends GridPanel>(
  panels: T[],
  panel: T,
): T | null {
  const compacted = compactPanels(panels);
  for (let y = 0; y <= 100 - panel.h; y++) {
    for (let x = 0; x <= 12 - panel.w; x++) {
      const candidate = { ...panel, x, y };
      if (!compacted.some((other) => overlaps(candidate, other)))
        return candidate;
    }
  }
  return null;
}
