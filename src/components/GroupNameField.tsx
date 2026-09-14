// An editable group name, used by service groups, the Services overlay editor and bookmark groups.
//
// Interaction contract (the same everywhere, so nothing has to be learned twice):
//   Enter   commits the name
//   Escape  abandons the edit and restores the stored name
//   blur    commits, when the name is valid
//   invalid input is refused with a visible reason while the field is being edited, and reverts
//     to the stored name when the field is left — the stored name is never blanked
//   a duplicate is refused by name, deterministically, instead of silently merging two groups
//
// The field keeps its own draft while typing. The parent only hears about a *committed* name, so a
// half-typed name can never be written to services.yaml or bookmarks.yaml, and re-renders from a
// poll can never fight the cursor.
import { useEffect, useId, useRef, useState } from 'react';
import { checkGroupName } from '../lib/groupName';

export interface GroupNameFieldProps {
  name: string;
  /** every other group name in the document (the row itself excluded) */
  existing: string[];
  onCommit: (name: string) => void;
  ariaLabel: string;
  /** focus and select on mount — used right after “+ New group” */
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}

export function GroupNameField({
  name, existing, onCommit, ariaLabel, autoFocus = false, placeholder, className = 'input group-name',
}: GroupNameFieldProps) {
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteId = useId();

  // the stored name is the source of truth whenever the field is not being edited
  useEffect(() => { if (!editing) { setDraft(name); setProblem(null); } }, [name, editing]);
  useEffect(() => {
    if (autoFocus) { input.current?.focus(); input.current?.select(); }
  }, [autoFocus]);

  /** Validate and store the draft. Returns false when the name was refused — the draft is kept
   *  so it can be fixed, and leaving the field restores the stored name instead. */
  const commit = () => {
    const result = checkGroupName(draft, { existing, current: name });
    if (!result.ok) { setProblem(result.reason || 'That name cannot be used.'); return false; }
    setProblem(null);
    setEditing(false);
    if (!result.unchanged) onCommit(result.name);
    setDraft(result.name);
    return true;
  };

  const cancel = () => { setDraft(name); setProblem(null); setEditing(false); };

  return (
    <>
      <input
        ref={input}
        className={className}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? noteId : undefined}
        onChange={(e) => { setEditing(true); setDraft(e.target.value); setProblem(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); input.current?.blur(); }
        }}
        onBlur={() => { if (!commit()) cancel(); }}
      />
      {problem && <span className="name-note" id={noteId} role="alert">{problem}</span>}
    </>
  );
}
