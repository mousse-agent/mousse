import { Check } from '../../lib/icons'
import '../../styles/wizard-steps.css'

/**
 * A numbered step bar for a dialog made of steps (Add provider, New bot). Finished steps show a
 * check and can be revisited; later steps cannot be skipped to.
 */
export function WizardSteps({
  steps,
  current,
  summaries = [],
  disabled = false,
  onStep
}: {
  steps: readonly string[]
  current: number
  /** Said after a finished step's name ("Provider: Claude Code"). */
  summaries?: ReadonlyArray<string | null>
  disabled?: boolean
  onStep: (step: number) => void
}) {
  return (
    <ol className="wizard-steps" aria-label="Steps">
      {steps.map((step, index) => (
        <li key={step}>
          <button
            type="button"
            className={`wizard-step${index === current ? ' is-current' : ''}${index < current ? ' is-done' : ''}`}
            aria-current={index === current ? 'step' : undefined}
            disabled={disabled || index > current}
            onClick={() => onStep(index)}
          >
            <span className="wizard-step-num">{index < current ? <Check size={13} /> : index + 1}</span>
            <span className="wizard-step-label">
              {step}
              {index < current && summaries[index] ? `: ${summaries[index]}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}
