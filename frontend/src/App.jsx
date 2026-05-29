import { Link, NavLink, Outlet } from 'react-router-dom'
import './App.css'
import PlayerDock from './components/PlayerDock'
import { usePlayer } from './context/usePlayer'

function App() {
  const { current, stageActive } = usePlayer()
  const dockVisible = !!current && !stageActive
  const navLinkClass = ({ isActive }) =>
    `font-label-md text-label-md transition-colors px-3 py-1 rounded-lg ${
      isActive
        ? 'text-primary bg-surface-container-high'
        : 'text-on-surface-variant hover:bg-surface-container-high'
    }`

  return (
    <div className="flex flex-col min-h-screen bg-background text-on-background">
      <header className="w-full top-0 sticky z-40 bg-surface border-b border-surface-variant">
        <div className="w-full flex justify-between items-center px-gutter py-4 max-w-container-max mx-auto">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 no-underline">
              <svg viewBox="0 0 50 50" fill="none" className="w-8 h-8 shrink-0" aria-hidden="true">
                <rect x="18" y="18" width="14" height="14" fill="#D9A441" />
                <path d="M4 16 L4 4 L16 4" stroke="currentColor" strokeWidth="5" strokeLinecap="square" className="text-on-surface" />
                <path d="M46 34 L46 46 L34 46" stroke="currentColor" strokeWidth="5" strokeLinecap="square" className="text-on-surface" />
              </svg>
              <h1 className="text-headline-md font-headline-md text-primary tracking-tight">
                Tubekeep
              </h1>
            </Link>
          </div>
          <div className="flex items-center gap-gutter">
            <div className="hidden md:flex items-center gap-2">
              <NavLink to="/" end className={navLinkClass}>
                Home
              </NavLink>
              <NavLink to="/downloads" className={navLinkClass}>
                Downloads
              </NavLink>
            </div>
          </div>
        </div>
      </header>

      <main
        className={`flex-1 px-gutter py-stack-lg max-w-container-max mx-auto w-full ${
          dockVisible ? 'pb-24' : ''
        }`}
      >
        <Outlet />
      </main>

      <PlayerDock />
    </div>
  )
}

export default App
