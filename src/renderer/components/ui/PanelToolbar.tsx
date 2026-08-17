import type { ReactNode } from 'react'

export function PanelToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="panel-toolbar">
      <span className="panel-toolbar-left">{left}</span>
      <span className="panel-toolbar-right">{right}</span>
    </div>
  )
}
