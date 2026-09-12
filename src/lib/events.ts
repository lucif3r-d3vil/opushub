// Human-readable wording for activity events — one place, used by the Hub rail,
// the Activity page and the detail pages.
import type { ActivityEvent } from './types';

export function humanEvent(e: ActivityEvent): string {
  if (e.source === 'docker') {
    if (e.type === 'container.started') return 'container started';
    if (e.type === 'container.exited') return 'container exited';
    if (e.type === 'container.state') return `container ${e.message || 'changed'}`;
    if (e.type === 'container.discovered') return 'seen in Docker';
    if (e.type === 'container.removed') return 'no longer running in Docker';
    return e.message || e.type;
  }
  if (e.source === 'user' && e.type === 'service.launch') return e.message || 'opened';
  const map: Record<string, string> = {
    'app.boot': 'OpusHub started',
    'app.shutdown': 'OpusHub stopped',
    'docker.ok': 'Docker engine connected',
    'docker.unavailable': 'Docker engine disconnected',
    'docker.error': 'Docker error',
    'settings.updated': 'settings updated',
    'layout.updated': 'hub layout changed',
    'services.updated': 'services updated',
    'stacks.updated': 'stacks updated',
    'bookmarks.updated': 'bookmarks updated',
    'custom.updated': 'custom assets updated',
  };
  return map[e.type] || e.message || e.type;
}
