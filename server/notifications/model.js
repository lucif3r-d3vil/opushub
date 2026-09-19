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
  if (evt.type.startsWith('monitor.')) return '/monitoring';
  if (evt.type.startsWith('alert.')) return '/';
  if (evt.type.startsWith('operation.')) return '/operations';
  if (evt.type.startsWith('infrastructure.')) return '/infrastructure';
  if (evt.type.startsWith('service.')) return '/';
  return '/activity';
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
    href: n.href && typeof n.href === 'string' && n.href.startsWith('/') ? n.href : null,
    subject: n.subject,
    correlation: n.correlation,
    read: !!n.read,
    readAt: n.readAt || null,
    createdAt: n.createdAt || n.t,
  };
}
