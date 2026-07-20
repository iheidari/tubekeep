import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import './App.css'
import Logo from './components/Logo'
import PlayerDock from './components/PlayerDock'
import ThemeToggle from './components/ThemeToggle'
import { useAuth } from './context/useAuth'
import { usePlayer } from './context/usePlayer'

function App() {
  const { current, stageActive } = usePlayer()
  const { user, loading, logout } = useAuth()
  const navigate = useNavigate()
  const dockVisible = !!current && !stageActive
  const navLinkClass = ({ isActive }) =>
    `font-label-md text-[13.5px] transition-colors px-3 py-2 rounded-lg ${
      isActive ? 'text-ink' : 'text-muted hover:text-ink'
    }`

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex flex-col min-h-screen bg-bg text-ink">
      <header className="w-full top-0 sticky z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="w-full flex justify-between items-center px-gutter py-4 max-w-container-max mx-auto">
          <Link to="/" className="no-underline" aria-label="Tubekeep home">
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Home
            </NavLink>
            <NavLink to="/downloads" className={navLinkClass}>
              Downloads
            </NavLink>
            <span className="w-px h-5 bg-line mx-1.5" aria-hidden="true" />
            <ThemeToggle />
            {/* Hold the auth control until /api/auth/me resolves, so an authed
                user doesn't flash "Log in" on every full page load. */}
            {!loading && (
              <>
                <span className="w-px h-5 bg-line mx-1.5" aria-hidden="true" />
                {user ? (
                  <>
                    <span
                      className="font-label-md text-[13.5px] text-muted max-w-[14ch] truncate"
                      title={user.email}
                    >
                      {user.name || user.email}
                    </span>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="font-label-md text-[13.5px] text-muted hover:text-ink transition-colors px-3 py-2 rounded-lg inline-flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                        logout
                      </span>
                      Logout
                    </button>
                  </>
                ) : (
                  <Link
                    to="/login"
                    className="font-label-md text-[13.5px] text-muted hover:text-ink transition-colors px-3 py-2 rounded-lg"
                  >
                    Log in
                  </Link>
                )}
              </>
            )}
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
