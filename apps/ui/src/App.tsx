import { api } from './api';
import { Ads } from './pages/Ads';
import { Channel } from './pages/Channel';
import { Cursors } from './pages/Cursors';
import { Dashboard } from './pages/Dashboard';
import { useRoute } from './router';
import { useLoad } from './useLoad';

export function App() {
  const route = useRoute();
  const server = useLoad(api.health, 'server');
  return (
    <>
      <header className="top">
        <a className="brand" href="#/">DayTuner</a>
        <nav aria-label="Pages"><a href="#/" aria-current={route.page === 'dashboard' ? 'page' : undefined}>Channels</a></nav>
        {server.data && (
          <span className={`mode ${server.data.writes ? 'writes' : ''}`} title={server.data.writes ? 'This server can write lineups to Tunarr and runs the daily scheduler' : 'This server only reads and plans; it cannot write to Tunarr'}>
            {server.data.writes ? 'may write to Tunarr' : 'read only'}
          </span>
        )}
      </header>
      <main>
        {server.error && <p className="error" role="alert">Cannot reach the DayTuner server: {server.error}</p>}
        {route.page === 'dashboard' ? <Dashboard /> : route.page === 'cursors' ? <Cursors name={route.name} /> : route.page === 'ads' ? <Ads name={route.name} /> : <Channel name={route.name} />}
      </main>
    </>
  );
}
