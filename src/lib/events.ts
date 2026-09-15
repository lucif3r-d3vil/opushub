// Human-readable wording for activity events — one place, used by the Hub rail,
// the Activity page and the detail pages.
import type { ActivityEvent, ActivityGroup } from './types';

export function humanEvent(e: ActivityEvent): string {
  if (e.source === 'docker') {
    if (e.type === 'container.started') return 'container started';
    if (e.type === 'container.exited') return 'container exited';
    if (e.type === 'container.health') return e.message || 'health changed';
    if (e.type === 'container.state') return `container ${e.message || 'changed'}`;
    if (e.type === 'container.discovered') return 'seen in Docker';
    if (e.type === 'container.removed') return 'no longer running in Docker';
    if (e.type === 'stack.appeared') return 'stack appeared';
    if (e.type === 'stack.removed') return 'stack removed';
    return e.message || e.type;
  }
  if (e.source === 'user' && e.type === 'service.launch') return e.message || 'opened';
  const map: Record<string, string> = {
    'app.boot': 'OpusHub started',
    'app.shutdown': 'OpusHub stopped',
    'docker.ok': 'Docker engine connected',
    'docker.unavailable': 'Docker engine disconnected',
    'docker.error': 'Docker error',
    'provider.unavailable': 'provider became unavailable',
    'provider.recovered': 'provider recovered',
    'settings.updated': 'settings updated',
    'layout.updated': 'hub layout changed',
    'services.updated': 'services updated',
    'stacks.updated': 'stacks updated',
    'bookmarks.updated': 'bookmarks updated',
    'custom.updated': 'custom assets updated',
    'discovery.refreshed': 'discovery refreshed',
    'alert.fired': 'alert fired',
    'alert.resolved': 'alert resolved',
    'auth.login_failed': 'failed login',
    'auth.login': 'logged in',
  };
  return map[e.type] || e.message || e.type;
}

/** Wording for a grouped burst — “Stack restarted · 5 containers changed state”. */
export function humanGroup(g: ActivityGroup): { title: string; detail: string } {
  const verbs: Record<string, string> = {
    'container.started': 'changed state',
    'container.exited': 'stopped',
    'container.state': 'changed state',
    'container.health': 'changed health',
    'container.discovered': 'appeared',
    'container.removed': 'disappeared',
  };
  const verb = verbs[g.type] || 'changed';
  const title = g.project
    ? `Stack ${g.type === 'container.started' ? 'restarted' : 'changed'} — ${g.count} containers ${verb}`
    : `${g.count} containers ${verb}`;
  return { title, detail: g.subjects.join(', ') };
}
