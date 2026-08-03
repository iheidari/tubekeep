import { Link } from 'react-router-dom'

function NotFoundPage() {
  return (
    <div className="max-w-[520px] mx-auto bg-surface border border-line rounded-2xl p-12 text-center">
      <span
        className="material-symbols-outlined text-[48px] text-faint mb-3 block"
        aria-hidden="true"
      >
        travel_explore
      </span>
      <h2 className="font-bold text-[24px] tracking-[-0.02em] text-ink mb-2">Page not found</h2>
      <p className="text-body-md text-muted mb-6">
        The page you were looking for doesn&apos;t exist.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-2 bg-fill text-on-fill font-semibold text-[14px] px-5 py-3 rounded-[10px] hover:opacity-90 active:scale-95 transition-all"
      >
        <span className="material-symbols-outlined text-[19px]" aria-hidden="true">
          arrow_back
        </span>
        Back to home
      </Link>
    </div>
  )
}

export default NotFoundPage
