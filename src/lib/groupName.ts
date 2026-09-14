// Group naming rules — small, pure, and shared by service groups and bookmark groups.
//
// These exist because renaming used to be keyed by the *old name*: the field's value came from the
// group object, the group was looked up by that same name, and clearing the input produced a rename
// to `""` that the helper silently dropped. The result was an editor that looked editable and a
// name that would not change. Addressing a group by its position instead, and validating the new
// name before it is committed, removes the whole class of problem.

export interface NameCheck {
  ok: boolean;
  /** the trimmed name that will be stored when ok */
  name: string;
  /** a sentence to show the user when !ok */
  reason?: string;
  /** true when the name is unchanged — a no-op commit, not an error */
  unchanged?: boolean;
}

export const MAX_GROUP_NAME = 80;

/**
 * Validate a proposed group name.
 * @param raw        what the user typed
 * @param existing   every other group name in the document (the row being renamed excluded)
 * @param current    the name this row currently has (so "unchanged" is a no-op, not a duplicate)
 */
export function checkGroupName(raw: string, { existing = [], current = '' }: { existing?: string[]; current?: string } = {}): NameCheck {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, name: '', reason: 'A group needs a name.' };
  if (name.length > MAX_GROUP_NAME) return { ok: false, name, reason: `Keep group names under ${MAX_GROUP_NAME} characters.` };
  if (!/^[A-Za-z0-9 ._'-]+$/.test(name)) {
    return { ok: false, name, reason: 'Letters, digits, spaces, dot, dash, underscore and apostrophe only.' };
  }
  if (name === current) return { ok: true, name, unchanged: true };
  const clash = existing.find((n) => n.toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, name, reason: `“${clash}” already uses that name.` };
  return { ok: true, name };
}

/** A name that is not taken yet: `New group`, `New group 2`, `New group 3`, … */
export function uniqueGroupName(existing: string[], base = 'New group'): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

export interface NamedGroup { name: string; description?: string | null; icon?: string | null; services?: { group?: string | null }[] }

/**
 * Rename the group at `index` (position, never name) and re-point any service inside it that
 * carried the old name as an explicit override. Pure: returns a new array.
 */
export function renameGroupAt<T extends NamedGroup>(groups: T[], index: number, name: string): T[] {
  const next = structuredClone(groups) as T[];
  const target = next[index];
  if (!target) return next;
  const from = target.name;
  target.name = name;
  for (const g of next) {
    for (const s of g.services || []) if (s && s.group === from) s.group = name;
  }
  return next;
}
