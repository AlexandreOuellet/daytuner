import type { Health } from '../api';

/** The state of a channel, in words and a mark (never colour alone). */
export function StatusBadge({ status }: { status: Health['status'] }) {
  return status === 'ok'
    ? <span className="badge ok"><span aria-hidden="true">✓</span> ok</span>
    : <span className="badge warn"><span aria-hidden="true">!</span> needs attention</span>;
}
