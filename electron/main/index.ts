import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

if (typeof process.setSourceMapsEnabled === 'function') {
  process.setSourceMapsEnabled(true)
}

const userDataArg = process.argv.find(arg => arg.startsWith('--user-data-dir='))
if (userDataArg) {
  const userDataPath = userDataArg.slice('--user-data-dir='.length)
  if (path.isAbsolute(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true })
    app.setPath('userData', userDataPath)
  }
}

import('./app')
