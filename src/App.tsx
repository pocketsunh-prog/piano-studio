import { DEMO_SONGS } from './music/demo';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">♪</span>
          <div>
            <h1>Piano Studio</h1>
            <p>Play · Read · Practice</p>
          </div>
        </div>
      </header>
      <main className="app-main">
        <p className="muted">Scaffolding complete. {DEMO_SONGS.length} demo songs loaded.</p>
      </main>
    </div>
  );
}
