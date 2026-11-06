import type { AgentModel, ModelScene } from '../shared/types'
import { resolveModel } from '../shared/types'
import { state } from './appState'

/** The model `scene` runs on now, by the rules in Settings: its own rule, else the fallback. */
export const modelFor = (scene: ModelScene): AgentModel => resolveModel(state.settings.models, scene)
