import { Search, X } from '../../lib/icons'

export function SearchInput({ value, onChange, placeholder = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="search-input-row">
      <Search size={14} />
      <input aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {value ? (
        <button type="button" onClick={() => onChange('')} aria-label="Clear">
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}
