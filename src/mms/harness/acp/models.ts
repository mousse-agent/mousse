import type { NewSessionResponse } from '@agentclientprotocol/sdk'
import type { LlmModelOption } from '../../../shared/settings'

/** The models of a `model` select config option, groups flattened. */
export function modelOptions(session: Pick<NewSessionResponse, 'configOptions'>): LlmModelOption[] {
  const selector = session.configOptions?.find((option) => option.id === 'model' && option.type === 'select')
  if (!selector || selector.type !== 'select') return []
  return selector.options.flatMap((item) => 'options' in item
    ? item.options.map((option) => ({ id: option.value, label: option.name }))
    : [{ id: item.value, label: item.name }])
}
