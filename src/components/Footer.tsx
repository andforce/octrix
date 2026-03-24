export function Footer() {
  return (
    <footer className="border-t border-border py-10">
      <div className="mx-auto max-w-6xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 512 512" className="h-6 w-6" fill="none">
            <circle cx="190" cy="290" r="140" stroke="#4fd1c5" strokeWidth="48" strokeLinecap="round" strokeDasharray="600 280" />
            <circle cx="322" cy="222" r="140" stroke="#f9b233" strokeWidth="48" strokeLinecap="round" strokeDasharray="600 280" />
            <circle cx="190" cy="290" r="28" fill="#4fd1c5" />
            <circle cx="322" cy="222" r="28" fill="#f9b233" />
          </svg>
          <span className="font-display text-sm font-bold text-content-muted">octrix</span>
        </div>

        {/* Links */}
        <div className="flex items-center gap-6 text-sm text-content-subtle">
          <a
            href="https://github.com/andforce/octrix"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-content"
          >
            GitHub
          </a>
          <span className="h-3 w-px bg-border" />
          <span>&copy; {new Date().getFullYear()} Octrix</span>
        </div>
      </div>
    </footer>
  )
}
