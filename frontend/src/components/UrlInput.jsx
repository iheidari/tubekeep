import { useState } from 'react'

const SOURCES = ['YouTube', 'Vimeo', 'TikTok', '+1,000 sites']

// Id linking the "no URL entered" reason to the submit button via
// aria-describedby, same pairing FormatSelector uses for its own reason.
const NO_URL_ID = 'url-required-hint'

function UrlInput({ onSubmit, loading }) {
  const [url, setUrl] = useState('')
  const empty = !url.trim()
  const inactive = loading || empty

  const handleSubmit = (e) => {
    e.preventDefault()
    if (url.trim()) {
      onSubmit(url.trim())
    }
  }

  return (
    <section className="flex flex-col items-center text-center pt-stack-lg pb-stack-md">
      <span className="font-label-md text-[12px] tracking-[0.14em] uppercase text-muted mb-stack-md">
        yt-dlp, made pleasant
      </span>
      <h1 className="font-display-xl text-display-xl text-ink max-w-[15ch] mb-stack-sm">
        Download it. Keep it.
      </h1>
      <p className="font-body-lg text-body-lg text-muted max-w-[52ch] mb-stack-lg">
        Paste a link from YouTube, Vimeo, TikTok and a thousand more. Pick your quality, watch it
        here, save it forever.
      </p>

      <form onSubmit={handleSubmit} className="w-full max-w-[680px]">
        <div className="flex items-center gap-1 bg-surface border border-line2 rounded-xl pl-5 pr-2 py-2 shadow-sm focus-within:border-ink transition-colors">
          <span className="material-symbols-outlined text-[24px] text-faint">link</span>
          <input
            type="url"
            placeholder="Paste video URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            required
            className="flex-1 min-w-0 bg-transparent border-none focus:ring-0 font-body-lg text-[17px] placeholder:text-faint text-ink px-3.5 py-3.5 outline-none"
          />
          <button
            type="submit"
            onClick={(e) => {
              // aria-disabled, not disabled: a `disabled` button drops out of
              // the tab order, so its aria-describedby reason (and the
              // Enter-key path below) would never reach a keyboard/screen
              // reader user. Guard the click here instead.
              if (inactive) e.preventDefault()
            }}
            aria-disabled={inactive}
            aria-describedby={empty && !loading ? NO_URL_ID : undefined}
            className={`flex items-center gap-2 bg-fill text-on-fill font-label-md text-[15px] px-6 py-3.5 rounded-lg transition-all shrink-0 ${
              inactive ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90 active:scale-[0.98]'
            }`}
          >
            {loading ? (
              <>
                <span className="material-symbols-outlined animate-spin text-[20px]">
                  progress_activity
                </span>
                <span className="hidden sm:inline">Loading…</span>
              </>
            ) : (
              <>
                <span className="hidden sm:inline">Get formats</span>
                <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
              </>
            )}
          </button>
          {empty && !loading ? (
            <span id={NO_URL_ID} className="sr-only">
              Paste a video URL first
            </span>
          ) : null}
        </div>
      </form>

      <div className="flex items-center flex-wrap justify-center gap-x-[18px] gap-y-2 mt-stack-md font-label-md text-[13px] text-faint">
        {SOURCES.map((s, i) => (
          <span key={s} className="flex items-center gap-x-[18px]">
            {i > 0 && <span className="w-[3px] h-[3px] rounded-full bg-line2" aria-hidden="true" />}
            {s}
          </span>
        ))}
      </div>
    </section>
  )
}

export default UrlInput
