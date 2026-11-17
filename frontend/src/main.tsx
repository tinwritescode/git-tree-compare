import React from 'react'
import {createRoot} from 'react-dom/client'
import App from './App'
import {migrateLegacyStorage} from './legacy-storage'
import {enableWindowDrag} from '../wailsjs/runtime/runtime'

enableWindowDrag()
// Before the app reads its saved state.
await migrateLegacyStorage()

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
)
