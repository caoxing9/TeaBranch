/** Node's `os`, the two calls the services make. */
import { Fs } from 'teabranch/native'

export const homedir = (): string => Fs.homeDir()
export const tmpdir = (): string => Fs.tmpDir()
export const platform = (): string => 'darwin'
export const EOL = '\n'
