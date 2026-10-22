import { issues } from './issues'
import { main } from './main'
import { ui } from './ui'

/** The English catalog, split by area so the files stay reviewable. */
export const en: Record<string, string> = { ...main, ...issues, ...ui }
