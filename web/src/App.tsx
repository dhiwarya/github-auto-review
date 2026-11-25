import { useEffect, useState } from 'react';
import type { Overview, ProviderStatus } from '../../src/types.ts';
import { postJson, useOverview, useTick } from './api.ts';
import { JobView } from './pages/JobView.tsx';
import { LeaderboardPage } from './pages/Leaderboard.tsx';
import { PrsPage } from './pages/Prs.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { reviewedRepos } from './repos.ts';
import { clockTime, ThemeToggle, timeAgo } from './ui.tsx';

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function ProviderPill({ p, role }: { p: ProviderStatus; role?: string }) {
  const name = `${p.provider === 'claude' ? 'Claude' : 'Codex'}${role ? ` (${role})` : ''}`;
  const blocked = p.blocked_until !== null;
  const auth = p.last_error?.startsWith('auth') || p.last_error?.startsWith('missing');
  const first = p.models[0]?.model ?? null;
  const onFallback = !blocked && p.active_model !== first;
  const label = blocked
    ? auth
      ? 'not signed in'
      : `paused until ${clockTime(p.blocked_until!)}`
    : onFallback
      ? `fallback ${p.active_model ?? 'default'}`
      : (p.active_model ?? 'ready');
  const chain = p.models.map((m) => `${m.model ?? 'default'}${m.blocked_until ? ` (paused until ${clockTime(m.blocked_until)})` : ''}`).join(' → ');
  return (
    <span className={`pill ${blocked || onFallback ? 'pill-warn' : 'pill-ok'}`} title={[`Models: ${chain}`, p.last_error].filter(Boolean).join('\n')}>
      <span className="dot" />
      {name}: {label}
    </span>
  );
}

// The provider that reviews. The backup shows up only when it's standing in, or has a problem.
function Providers({ overview }: { overview: Overview }) {
  const { provider, fallbackToOther } = overview.settings;
  const primary = overview.providers.find((p) => p.provider === provider);
  const backup = overview.providers.find((p) => p.provider !== provider);
  // The Strict profile is chosen per repo; it has the other provider review independently.
  const strict = reviewedRepos(overview.repos).some((r) => r.profile === 'strict');
  const showBackup = backup && (strict || (fallbackToOther && (primary?.blocked_until || backup.blocked_until)));
  return (
    <>
      {primary && <ProviderPill p={primary} />}
      {showBackup && <ProviderPill p={backup!} role={strict ? 'independent' : 'backup'} />}
    </>
  );
}

function Header({ overview, route }: { overview: Overview | null; route: string[] }) {
  useTick();
  const [polling, setPolling] = useState(false);
  const tab = route[0] ?? 'queue';
  const watched = reviewedRepos(overview?.repos);
  const dryRuns = watched.filter((r) => r.dryRun);
  const poll = async () => {
    setPolling(true);
    await postJson('/api/poll').catch(() => {});
    setTimeout(() => setPolling(false), 1500);
  };
  return (
    <header className="header">
      <div className="header-row">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            ✓
          </span>
          Auto Reviewer
        </a>
        <nav className="tabs" aria-label="Sections">
          <a className={tab === 'queue' || tab === 'jobs' ? 'active' : ''} href="#/">
            Queue
          </a>
          <a className={tab === 'prs' ? 'active' : ''} href="#/prs">
            Pull requests
          </a>
          <a className={tab === 'leaderboard' ? 'active' : ''} href="#/leaderboard/models">
            Leaderboard
          </a>
          <a className={tab === 'settings' ? 'active' : ''} href="#/settings">
            Settings
          </a>
        </nav>
        <div className="header-status">
          {overview?.me && (
            <a
              className="pill pill-ok"
              href={`https://github.com/${overview.me}`}
              target="_blank"
              rel="noreferrer"
              title={`Reviewing PRs that request @${overview.me}. Login from ${overview.github_auth}.`}
            >
              <span className="dot" />@{overview.me}
            </a>
          )}
          {overview && <Providers overview={overview} />}
          <span
            className="muted small"
            title={
              overview?.last_poll_error ??
              (overview ? `Watching ${overview.github.watching.length} repo(s). Last check: ${overview.github.last_cycle?.requests ?? 0} request(s), ${overview.github.last_cycle?.notModified ?? 0} free.` : undefined)
            }
          >
            {overview?.github.paused_until
              ? `\u26A0\uFE0E Paused until ${clockTime(overview.github.paused_until)}`
              : overview?.last_poll_error
                ? '\u26A0\uFE0E Last check failed'
                : `Checked ${timeAgo(overview?.last_poll_at)}`}
          </span>
          <button className="btn btn-ghost btn-small" onClick={poll} disabled={polling}>
            {polling ? 'Checking…' : 'Check now'}
          </button>
          <ThemeToggle />
        </div>
      </div>
      {overview?.needs_setup ? (
        <div className="banner">
          <strong>{overview.repos.length ? 'Every repository is switched off.' : 'No repositories yet.'}</strong> Nothing is reviewed until you{' '}
          {overview.repos.length ? 'switch one on' : 'add the repos to review'}. <a href="#/settings">Open Settings</a>
        </div>
      ) : (
        dryRuns.length > 0 && (
          <div className="banner">
            <strong>Dry run{dryRuns.length === watched.length ? '' : ` for ${dryRuns.map((r) => r.repo).join(', ')}`}.</strong> {dryRuns.length === watched.length ? 'Reviews run' : 'Its reviews run'}, but nothing is
            posted to GitHub and no labels change. Turn it off in <a href="#/settings">Settings</a> when the reviews look right.
          </div>
        )
      )}
      {overview?.paused_reason && <div className="banner banner-muted">{overview.paused_reason}. Queued reviews start after that.</div>}
    </header>
  );
}

export function App() {
  const route = useHashRoute();
  const overview = useOverview();
  let page;
  if (route[0] === 'jobs' && route[1]) page = <JobView id={Number(route[1])} />;
  else if (route[0] === 'prs') page = <PrsPage />;
  else if (route[0] === 'leaderboard') page = <LeaderboardPage kind={(route[1] as 'models' | 'repos' | 'authors') ?? 'models'} />;
  else if (route[0] === 'settings') page = <SettingsPage overview={overview} tab={route[1] === 'app' ? 'app' : 'repos'} />;
  else page = <QueuePage overview={overview} />;
  return (
    <>
      <Header overview={overview} route={route} />
      <main className="main">{page}</main>
    </>
  );
}
