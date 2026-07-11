export type ProviderAuthType = 'api_key' | 'oauth'

export interface ConfiguredProvider {
  id: string
  label: string
  authType: ProviderAuthType
  source?: string
}

export interface ProviderLoginOption {
  id: string
  label: string
  authType: ProviderAuthType
  configured: boolean
  ambient?: boolean
}

export type ProviderLoginEvent =
  | {
      sessionId: string
      type: 'auth_url'
      url: string
      instructions?: string
      usesCallbackServer: boolean
    }
  | {
      sessionId: string
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      sessionId: string
      type: 'progress'
      message: string
    }
  | {
      sessionId: string
      type: 'prompt'
      promptType: 'text' | 'secret'
      message: string
      placeholder?: string
    }
  | {
      sessionId: string
      type: 'select'
      message: string
      options: Array<{ id: string; label: string; description?: string }>
    }
  | {
      sessionId: string
      type: 'manual_code'
      message: string
    }

export interface ProviderLoginResponse {
  sessionId: string
  kind: 'prompt' | 'select' | 'manual_code' | 'cancel'
  value?: string
}

export interface ProviderLoginResult {
  success: boolean
  error?: string
  sessionId?: string
}

export interface AmbientProviderInfo {
  id: string
  label: string
  instructions: string[]
}
