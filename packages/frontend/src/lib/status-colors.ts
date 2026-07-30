/**
 * Shared status → tailwind color helpers.
 *
 * These were duplicated as inline maps in HomeDashboard, PrinterDashboard,
 * PrinterDetail (connection colors) and JobList (job-status colors).
 * Centralizing so a future theme change is one edit, and so the values
 * can't drift between components.
 */

/** Tailwind bg-* class for a printer connection state (used for status dots). */
export function connectionColor(connection: string): string {
  switch (connection) {
    case 'connected': return 'bg-green-500';
    case 'connecting': return 'bg-yellow-500';
    case 'disconnected':
    case 'error': return 'bg-red-500';
    default: return 'bg-gray-500';
  }
}

/** Tailwind bg-* class for a slice-job status (used for status dots). */
export function jobStatusColor(status: string): string {
  switch (status) {
    case 'queued': return 'bg-yellow-500';
    case 'running': return 'bg-blue-500';
    case 'completed': return 'bg-green-500';
    case 'failed': return 'bg-red-500';
    case 'cancelled': return 'bg-gray-500';
    default: return 'bg-gray-500';
  }
}
