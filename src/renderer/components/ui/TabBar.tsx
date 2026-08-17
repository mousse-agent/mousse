import { Plus, X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface TabItem { id: string; label: ReactNode; active?: boolean; icon?: ReactNode }

export function TabBar({ tabs, onSelect, onClose, onAdd, addLabel = 'New' }: { tabs: TabItem[]; onSelect: (id: string) => void; onClose?: (id: string) => void; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="tab-bar">
      {tabs.map((t) => (
        <div key={t.id} className={`tab ${t.active ? 'tab-active' : ''}`.trim()}>
          <button type="button" className="tab-select" onClick={() => onSelect(t.id)}>
            {t.icon}
            <span className="tab-label">{t.label}</span>
          </button>
          {onClose ? (
            <button type="button" className="tab-close" aria-label="Close" onClick={() => onClose(t.id)}>
              <X size={12} />
            </button>
          ) : null}
        </div>
      ))}
      {onAdd ? (
        <button type="button" className="tab-add" aria-label={addLabel} onClick={onAdd}>
          <Plus size={14} />
        </button>
      ) : null}
    </div>
  )
}
