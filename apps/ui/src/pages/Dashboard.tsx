import { api, type Card } from '../api';
import { StatusBadge } from '../components/Status';
import { days, pct } from '../format';
import { channelLink } from '../router';
import { useLoad } from '../useLoad';

export function CardView({ card }: { card: Card }) {
  const h = card.health;
  const bad = h.checks.filter((c) => !c.ok);
  return (
    <article className={`card ${h.status === 'ok' ? '' : 'attention'}`}>
      <header>
        <h2><a href={channelLink(card.name)}>{card.name}</a></h2>
        <StatusBadge status={h.status} />
      </header>
      <p className="ahead">committed {days(h.headline.aheadMs)} ahead</p>
      <dl className="numbers">
        <div><dt>Ad load</dt><dd>{h.headline.adLoad === undefined ? '–' : pct(h.headline.adLoad)}</dd></div>
        <div><dt>Dead air</dt><dd>{h.headline.deadAirShare === undefined ? '–' : pct(h.headline.deadAirShare, 2)}</dd></div>
        <div><dt>Repeats</dt><dd>{h.headline.repeats ?? '–'}</dd></div>
        <div><dt>Alerts, last commit</dt><dd>{h.headline.alerts ?? '–'}</dd></div>
      </dl>
      {bad.length > 0 && (
        <ul className="problems">{bad.map((c) => <li key={c.name}><strong>{c.name}.</strong> {c.detail}</li>)}</ul>
      )}
      <footer>
        {card.pendingCommit && <span className="chip">a commit is pending</span>}
        {card.staged > 0 && <span className="chip">{card.staged} staged slot{card.staged === 1 ? '' : 's'}</span>}
        <a href={channelLink(card.name)}>Open</a>
      </footer>
    </article>
  );
}

export function Dashboard() {
  const { data, error, loading, reload } = useLoad(api.dashboard, 'dashboard');
  return (
    <section>
      <div className="page-head">
        <h1>Channels</h1>
        <button type="button" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && data.length === 0 && <p className="muted">No channels yet. Add one with <code>daytuner channel add</code>.</p>}
      <div className="cards">{data?.map((c) => <CardView key={c.name} card={c} />)}</div>
    </section>
  );
}
