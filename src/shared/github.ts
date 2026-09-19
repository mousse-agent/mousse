export type GitHubAvailabilityState =
  | 'ready'
  | 'missing'
  | 'unauthenticated'
  | 'error'
  | 'busy'

export interface GitHubAvailability {
  state: GitHubAvailabilityState
  message: string
  loginCommand?: string
}

export type GitHubRepositoryVisibility = 'private' | 'public'

export interface GitHubCreateRepositoryInput {
  projectId: string
  name: string
  visibility: GitHubRepositoryVisibility
}

export interface GitHubCreateRepositoryResult {
  repositoryUrl?: string
}

export interface GitHubCloneRepositoryInput {
  repository: string
  destination: string
}

export interface GitHubProjectSummary {
  id: string
  name: string
  path: string
  createdAt: string
  order: number
}

export interface GitHubCloneRepositoryResult {
  project: GitHubProjectSummary
}

export interface GitHubApi {
  status(): Promise<GitHubAvailability>
  createRepository(input: GitHubCreateRepositoryInput): Promise<GitHubCreateRepositoryResult>
  chooseCloneDestination(): Promise<string | null>
  cloneRepository(input: GitHubCloneRepositoryInput): Promise<GitHubCloneRepositoryResult>
}
