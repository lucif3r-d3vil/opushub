// Phase 10B — Notification model

import { randomUUID } from 'node:crypto';

export const NOTIF_SEVERITIES = ['info', 'notice', 'warning', 'critical'];

function sanitizeString(s, max = 300) {
  if (s == null) return '';
  let str = String(s);
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (str.length > max) str = str.slice(0, max);
  return str;
}

export function makeNotificationFromEvent(evt) {
  if (!evt || !evt.id) return null;
  const id = `notif-${randomUUID()}`;
  const title = deriveTitle(evt);
  const message = sanitizeString(evt.message || title, 500);
  return {
    id,
    eventId: evt.id,
    t: evt.t || Date.now(),
    type: evt.type,
    severity: evt.severity || 'info',
    source: evt.source || 'system',
    title,
    message,
    href: evt.subject?.href || deriveHref(evt),
    subject: evt.subject || null,
    correlation: evt.correlation || null,
    read: false,
    readAt: null,
    createdAt: Date.now(),
  };
}

function deriveTitle(evt) {
  if (evt.subject?.label) {
    return `${humanType(evt.type)}: ${evt.subject.label}`;
  }
  return humanType(evt.type);
}

function humanType(type) {
  const map = {
    'monitor.state_changed': 'Monitor status changed',
    'monitor.incident.opened': 'Incident opened',
    'monitor.incident.recovered': 'Incident recovered',
    'alert.created': 'Alert',
    'alert.resolved': 'Alert resolved',
    'operation.completed': 'Operation completed',
    'operation.failed': 'Operation failed',
    'operation.timed_out': 'Operation timed out',
    'infrastructure.health_changed': 'Infrastructure health changed',
    'service.down': 'Service down',
    'service.up': 'Service recovered',
    'service.unhealthy': 'Service unhealthy',
    'service.healthy': 'Service healthy',
  };
  return map[type] || type.replace(/_/g, ' ').replace(/\./g, ' — ');
}

function deriveHref(evt) {
  if (evt.subject?.href) return evt.subject.href;
  // Fallbacks must name routes that exist in the SPA. There is no /operations page —
  // operation outcomes are reviewed in the service list and the activity timeline.
  if (evt.type.startsWith('monitor.')) return '/monitoring';
  if (evt.type.startsWith('alert.')) return '/activity';
  if (evt.type.startsWith('operation.')) return '/services';
  if (evt.type.startsWith('infrastructure.')) return '/infrastructure';
  if (evt.type.startsWith('service.')) return '/services';
  return '/activity';
}

function sanitizeHref(href) {
  // Internal paths only: a leading // is a protocol-relative URL to another host, not a
  // route in this app. (The client re-checks with safeHref; this is the server's gate.)
  if (typeof href !== 'string' || !href) return null;
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  return href.slice(0, 500);
}

function sanitizeSubject(subject) {
  if (!subject || typeof subject !== 'object') return null;
  return {
    kind: sanitizeString(subject.kind, 40) || null,
    id: sanitizeString(subject.id, 120) || null,
    label: sanitizeString(subject.label, 200) || null,
    href: sanitizeHref(subject.href),
  };
}

function sanitizeCorrelation(correlation) {
  if (!correlation || typeof correlation !== 'object') return null;
  const out = {};
  let kept = 0;
  for (const [k, v] of Object.entries(correlation)) {
    if (kept >= 20) break;
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    out[sanitizeString(k, 60)] = sanitizeString(v, 200);
    kept++;
  }
  return out;
}

export function sanitizeNotification(n) {
  if (!n) return null;
  return {
    id: n.id,
    eventId: n.eventId,
    t: n.t,
    type: n.type,
    severity: n.severity,
    source: n.source,
    title: sanitizeString(n.title, 200),
    message: sanitizeString(n.message, 500),
    href: sanitizeHref(n.href),
    subject: sanitizeSubject(n.subject),
    correlation: sanitizeCorrelation(n.correlation),
    read: !!n.read,
    readAt: n.readAt || null,
    createdAt: n.createdAt || n.t,
  };
}
