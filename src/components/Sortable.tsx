// In-house sortable. During a drag the DOM never moves — items shift via transforms; the new
// order commits once, on drop, and the list FLIPs into place. Keyboard: Space picks up,
// arrows move (each move commits instantly), Space/Esc/Enter drop. One mechanism for every
// draggable surface in OpusHub (hub sections, rail widgets, service tiles, groups, editors).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface SortableCtx {
  id: string;
  handle: ReactNode;
  dragging: boolean;
  grabbed: boolean;
}

type Rect = { x: number; y: number; w: number; h: number };

export function Sortable({
  ids, onReorder, className = '', itemClassName = '', renderItem, disabled = false,
}: {
  ids: string[];
  onReorder: (next: string[]) => void;
  className?: string;
  itemClassName?: string;
  renderItem: (id: string, ctx: SortableCtx) => ReactNode;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLUListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [grabId, setGrabId] = useState<string | null>(null);
  const drag = useRef<{
    id: string | null;
    startX: number; startY: number;
    rects: Rect[];            // per DOM slot in `ids` order
    idx: Map<string, number>; // id → index in ids
  }>({ id: null, startX: 0, startY: 0, rects: [], idx: new Map() });

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const cres = root.getBoundingClientRect();
    const rects: Rect[] = [];
    const idx = new Map<string, number>();
    let i = 0;
    root.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((li) => {
      const r = li.getBoundingClientRect();
      rects.push({ x: r.left - cres.left, y: r.top - cres.top, w: r.width, h: r.height });
      idx.set(li.dataset.sortableId!, i++);
    });
    drag.current.rects = rects;
    drag.current.idx = idx;
  }, []);

  const begin = useCallback((id: string, x: number, y: number) => {
    if (disabled) return;
    measure();
    drag.current.id = id;
    drag.current.startX = x;
    drag.current.startY = y;
    setDragId(id);
    document.documentElement.classList.add('is-dragging');
  }, [disabled, measure]);

  // pure: given a pointer position, what order would the slots be in?
  const previewOrder = useCallback((id: string, x: number, y: number) => {
    const { rects, idx } = drag.current;
    const root = rootRef.current;
    if (!root) return null;
    const cres = root.getBoundingClientRect();
    const px = x - cres.left;
    const py = y - cres.top;
    const me = idx.get(id);
    if (me == null) return null;
    const others = ids.filter((i) => i !== id);
    let slot = others.length;
    let bestD = Infinity;
    let k = 0;
    for (let i = 0; i < ids.length; i++) {
      if (i === me) continue;
      const r = rects[i];
      if (!r) continue;
      const d = Math.abs(r.y + r.h / 2 - py) + 0.75 * Math.abs(r.x + r.w / 2 - px);
      if (d < bestD) { bestD = d; slot = k; }
      k++;
    }
    const next = [...others];
    next.splice(slot, 0, id);
    return next;
  }, [ids]);

  const paint = useCallback((preview: string[] | null, dx: number, dy: number) => {
    const root = rootRef.current;
    if (!root) return;
    const { rects, idx, id } = drag.current;
    root.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((li) => {
      const lid = li.dataset.sortableId!;
      const own = idx.get(lid);
      if (own == null) return;
      if (lid === id) {
        li.style.transform = `translate(${dx}px, ${dy}px)`;
        return;
      }
      const target = preview ? preview.indexOf(lid) : own;
      const from = rects[own];
      const to = rects[Math.min(target, rects.length - 1)];
      if (to && from && target !== own) {
        li.classList.add('sortable-shift');
        li.style.transform = `translate(${to.x - from.x}px, ${to.y - from.y}px)`;
      } else {
        li.classList.remove('sortable-shift');
        li.style.transform = '';
      }
    });
  }, []);

  useEffect(() => {
    if (!dragId) return;
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.id) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const preview = previewOrder(d.id, e.clientX, e.clientY);
      paint(preview, dx, dy);
    };
    const end = () => {
      const d = drag.current;
      const root = rootRef.current;
      document.documentElement.classList.remove('is-dragging');
      const id = d.id;
      let preview: string[] | null = null;
      if (id && root && lastPointer.x != null && lastPointer.y != null) {
        preview = previewOrder(id, lastPointer.x, lastPointer.y);
      }
      if (id && preview && preview.some((p, i) => p !== ids[i])) {
        // commit, then FLIP from pre-drop visual positions to true new positions
        const before = new Map<string, Rect>();
        root!.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((li) => before.set(li.dataset.sortableId!, rectOf(li, root!)));
        d.id = null;
        setDragId(null);
        onReorder(preview);
        requestAnimationFrame(() => {
          const root2 = rootRef.current;
          if (!root2) return;
          root2.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((li) => {
            const lid = li.dataset.sortableId!;
            const b = before.get(lid);
            li.classList.remove('dragging');
            if (!b) { li.style.transform = ''; return; }
            const now = rectOf(li, root2);
            li.style.transition = 'none';
            li.style.transform = `translate(${b.x - now.x}px, ${b.y - now.y}px)`;
            requestAnimationFrame(() => {
              li.style.transition = 'transform 170ms cubic-bezier(0.22,0.61,0.36,1)';
              li.style.transform = '';
              window.setTimeout(() => { li.style.transition = ''; li.style.transform = ''; }, 210);
            });
          });
        });
      } else {
        d.id = null;
        setDragId(null);
        root?.querySelectorAll<HTMLElement>('[data-sortable-id]').forEach((li) => { li.style.transform = ''; li.classList.remove('sortable-shift'); });
      }
    };
    const lastPointer = { x: null as number | null, y: null as number | null };
    const track = (e: PointerEvent) => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, ids, onReorder, paint, previewOrder]);

  // keyboard pickup — one window-level handler owns the whole grab lifecycle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target.closest('.drag-handle') : null;
      if (e.key === ' ' || e.key === 'Enter') {
        if (t) {
          e.preventDefault();
          if (!grabId) {
            const lid = t.closest('[data-sortable-id]')?.getAttribute('data-sortable-id');
            if (lid) { measure(); setGrabId(lid); }
          } else {
            setGrabId(null);
          }
          return;
        }
        if (grabId) { e.preventDefault(); setGrabId(null); }
        return;
      }
      if (!grabId) return;
      if (e.key === 'Escape') { setGrabId(null); return; }
      const i = ids.indexOf(grabId);
      if (i < 0) { setGrabId(null); return; }
      let j = i;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(ids.length - 1, i + 1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
      if (j !== i) {
        e.preventDefault();
        const next = [...ids];
        next.splice(i, 1);
        next.splice(j, 0, grabId);
        onReorder(next);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [grabId, ids, onReorder, measure]);

  useEffect(() => () => document.documentElement.classList.remove('is-dragging'), []);

  return (
    <ul ref={rootRef} className={className}>
      {ids.map((id) => (
        <li key={id} data-sortable-id={id} className={`${itemClassName} ${dragId === id ? 'sortable-drag' : ''} ${grabId === id ? 'sortable-grabbed' : ''}`}>
          {renderItem(id, {
            id,
            dragging: dragId === id,
            grabbed: grabId === id,
            handle: disabled ? null : (
              <button
                type="button"
                className="drag-handle"
                title="Drag to reorder · Space to pick up"
                aria-label={`Reorder ${id}`}
                onPointerDown={(e) => {
                  e.preventDefault();
                  begin(id, e.clientX, e.clientY);
                }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
              </button>
            ),
          })}
        </li>
      ))}
    </ul>
  );
}

function rectOf(el: HTMLElement, root: HTMLElement): Rect {
  const cres = root.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - cres.left, y: r.top - cres.top, w: r.width, h: r.height };
}
