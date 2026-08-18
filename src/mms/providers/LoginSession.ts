import { EventEmitter } from 'events'
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import type { ProviderLoginEvent, ProviderLoginResponse } from '../../shared/providerAuth'

type PendingRequest =
  | {
      kind: 'prompt' | 'select'
      resolve: (value: string | undefined) => void
      reject: (error: Error) => void
    }
  | {
      kind: 'manual_code'
      resolve: (value: string) => void
      reject: (error: Error) => void
    }

export class LoginSession extends EventEmitter {
  private pending?: PendingRequest
  private manualCodePending?: PendingRequest & { kind: 'manual_code' }
  readonly abort = new AbortController()

  constructor(readonly sessionId: string) {
    super()
  }

  emitEvent(event: ProviderLoginEvent): void {
    this.emit('event', event)
  }

  respond(response: ProviderLoginResponse): void {
    if (response.sessionId !== this.sessionId) return

    if (response.kind === 'cancel') {
      this.pending?.reject(new Error('Login cancelled'))
      this.manualCodePending?.reject(new Error('Login cancelled'))
      this.abort.abort()
      return
    }

    if (response.kind === 'manual_code') {
      if (!this.manualCodePending) return
      if (!response.value?.trim()) {
        this.manualCodePending.reject(new Error('Login cancelled'))
        return
      }
      this.manualCodePending.resolve(response.value.trim())
      this.manualCodePending = undefined
      return
    }

    if (!this.pending) return
    if (response.kind === 'select' && !response.value) {
      this.pending.reject(new Error('Login cancelled'))
      this.pending = undefined
      return
    }
    if (response.kind === 'prompt' && !response.value?.trim()) {
      this.pending.reject(new Error('Login cancelled'))
      this.pending = undefined
      return
    }
    this.pending.resolve(response.value!)
    this.pending = undefined
  }

  createAuthCallbacks(): ProviderAuthInteraction {
    return {
      signal: this.abort.signal,
      prompt: (prompt: AuthPrompt) => {
        if (prompt.type === 'select') {
          return this.waitForSelect({
            message: prompt.message,
            options: prompt.options.map((option) => ({
              id: option.id,
              label: option.label,
              description: option.description
            }))
          }).then((value) => {
            if (!value) throw new Error('Login cancelled')
            return value
          })
        }

        if (prompt.type === 'manual_code') {
          return this.waitForManualCode(prompt.message)
        }

        return this.waitForPrompt(
          prompt.type === 'secret' ? 'secret' : 'text',
          prompt.message,
          prompt.placeholder
        )
      },
      notify: (event: AuthEvent) => {
        if (event.type === 'auth_url') {
          this.emitEvent({
            sessionId: this.sessionId,
            type: 'auth_url',
            url: event.url,
            instructions: event.instructions,
            usesCallbackServer: false
          })
          return
        }
        if (event.type === 'device_code') {
          this.emitEvent({
            sessionId: this.sessionId,
            type: 'device_code',
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds
          })
          return
        }
        if (event.type === 'progress') {
          this.emitEvent({ sessionId: this.sessionId, type: 'progress', message: event.message })
        }
      }
    }
  }

  private waitForPrompt(
    promptType: 'text' | 'secret',
    message: string,
    placeholder?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending = {
        kind: 'prompt',
        resolve: (value) => {
          if (!value?.trim()) {
            reject(new Error('Login cancelled'))
            return
          }
          resolve(value.trim())
        },
        reject
      }
      this.emitEvent({
        sessionId: this.sessionId,
        type: 'prompt',
        promptType,
        message,
        placeholder
      })
    })
  }

  private waitForManualCode(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.manualCodePending = { kind: 'manual_code', resolve, reject }
      this.emitEvent({ sessionId: this.sessionId, type: 'manual_code', message })
    })
  }

  private waitForSelect(prompt: {
    message: string
    options: ReadonlyArray<{ id: string; label: string; description?: string }>
  }): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'select', resolve, reject }
      this.emitEvent({
        sessionId: this.sessionId,
        type: 'select',
        message: prompt.message,
        options: [...prompt.options]
      })
    })
  }
}
