import { Link, useNavigate } from 'react-router-dom'
import UrlInput from '../components/UrlInput'
import { useHistory } from '../context/useHistory'

function HomePage() {
  const navigate = useNavigate()
  const { history, expired } = useHistory()
  const total = history.length + expired.length

  const handleSubmit = (url) => {
    navigate(`/info?url=${encodeURIComponent(url)}`)
  }

  return (
    <>
      <UrlInput onSubmit={handleSubmit} loading={false} />
      {total > 0 && (
        <div className="mt-stack-md flex justify-center">
          <Link
            to="/downloads"
            className="inline-flex items-center gap-2 text-muted hover:text-ink font-label-md text-label-md transition-colors group"
          >
            Your downloads
            <span className="bg-tint text-ink rounded-full px-2.5 py-0.5 text-[12px] font-semibold">
              {total}
            </span>
            <span
              className="material-symbols-outlined text-[18px] text-faint group-hover:translate-x-1 transition-transform"
              aria-hidden="true"
            >
              arrow_forward
            </span>
          </Link>
        </div>
      )}
    </>
  )
}

export default HomePage
