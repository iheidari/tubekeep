import { Link } from 'react-router-dom'

// The "← Back" link shown at the top of the info/play/format screens.
function BackLink({ to = '/', label = 'Back' }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-muted hover:text-ink font-semibold text-[13px] mb-stack-md transition-colors"
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        arrow_back
      </span>
      {label}
    </Link>
  )
}

export default BackLink
